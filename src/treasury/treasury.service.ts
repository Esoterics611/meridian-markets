import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DbService } from '@database/db.service';
import {
  IYieldProvider,
  YIELD_PROVIDER,
  YieldPosition,
} from '@yield/yield-provider.interface';
import { InsufficientPrincipalError, InvalidAmountError } from './treasury.errors';

export type MovementDirection = 'DEPOSIT' | 'WITHDRAW' | 'YIELD_ACCRUAL';

export interface PositionSnapshot {
  provider: string;
  principalUnits: bigint;
  yieldEarnedUnits: bigint;
  lastSyncedAt: Date;
}

export interface MovementRow {
  id: string;
  direction: MovementDirection;
  amountUnits: bigint;
  provider: string;
  externalRef: string | null;
  runningBalanceUnits: bigint;
  createdAt: Date;
}

// TreasuryService owns the append-only ledger and the cached position. Every
// state change runs in a SERIALIZABLE transaction so concurrent deposits or
// withdrawals can't lose money or double-spend the running balance.
//
// Idempotency: callers supply an idempotencyKey per movement. A replay of
// the same (provider, idempotencyKey) returns the original movement; the
// yield-provider mocks also dedupe on the same key.
@Injectable()
export class TreasuryService {
  constructor(
    private readonly db: DbService,
    @Inject(YIELD_PROVIDER) private readonly yieldProvider: IYieldProvider,
  ) {}

  async deposit(amountUnits: bigint, idempotencyKey: string): Promise<MovementRow> {
    this.assertPositive(amountUnits);

    // Side-effect on the yield provider first; if the provider fails the DB
    // tx never starts. The provider is also idempotent on idempotencyKey, so
    // a retry after a DB crash still converges.
    const result = await this.yieldProvider.deposit({ amountUnits, idempotencyKey });

    return this.db.runInSerializableTransaction(async (em) => {
      const existing = await this.findMovement(em, idempotencyKey);
      if (existing) return existing;

      const currentBalance = await this.currentPrincipal(em);
      const newBalance = currentBalance + result.acceptedUnits;

      const row = await this.insertMovement(em, {
        direction: 'DEPOSIT',
        amountUnits: result.acceptedUnits,
        externalRef: result.externalRef,
        idempotencyKey,
        runningBalanceUnits: newBalance,
      });
      await this.upsertPosition(em, newBalance, /* yieldDelta */ 0n);
      return row;
    });
  }

  async withdraw(amountUnits: bigint, idempotencyKey: string): Promise<MovementRow> {
    this.assertPositive(amountUnits);

    return this.db.runInSerializableTransaction(async (em) => {
      const existing = await this.findMovement(em, idempotencyKey);
      if (existing) return existing;

      const currentBalance = await this.currentPrincipal(em);
      if (amountUnits > currentBalance) {
        throw new InsufficientPrincipalError(
          this.yieldProvider.providerId,
          amountUnits,
          currentBalance,
        );
      }

      // Provider call inside the SERIALIZABLE tx is acceptable for the mock
      // (zero side-effects beyond memory). For the real Ondo provider this
      // ordering will move outside the tx with a saga/outbox — Phase 1+.
      const result = await this.yieldProvider.withdraw({ amountUnits, idempotencyKey });

      const newBalance = currentBalance - result.releasedUnits;
      const row = await this.insertMovement(em, {
        direction: 'WITHDRAW',
        amountUnits: result.releasedUnits,
        externalRef: result.externalRef,
        idempotencyKey,
        runningBalanceUnits: newBalance,
      });
      await this.upsertPosition(em, newBalance, /* yieldDelta */ 0n);
      return row;
    });
  }

  async getPosition(): Promise<PositionSnapshot> {
    const row = await this.db.runInSerializableTransaction((em) =>
      em.query<
        { provider: string; principal_units: string; yield_earned_units: string; last_synced_at: Date }[]
      >(
        `SELECT provider, principal_units, yield_earned_units, last_synced_at
           FROM treasury_positions
          WHERE provider = $1
          LIMIT 1`,
        [this.yieldProvider.providerId],
      ),
    );
    if (row.length === 0) {
      return {
        provider: this.yieldProvider.providerId,
        principalUnits: 0n,
        yieldEarnedUnits: 0n,
        lastSyncedAt: new Date(0),
      };
    }
    const r = row[0];
    return {
      provider: r.provider,
      principalUnits: BigInt(r.principal_units),
      yieldEarnedUnits: BigInt(r.yield_earned_units),
      lastSyncedAt: r.last_synced_at,
    };
  }

  async getYieldEarned(): Promise<bigint> {
    const pos = await this.getPosition();
    return pos.yieldEarnedUnits;
  }

  /**
   * Reconcile cached position against the provider and write a YIELD_ACCRUAL
   * row if the provider reports more yield than we've recorded. Unique index
   * on (provider, day) makes this idempotent within a 24h window.
   */
  async syncYield(): Promise<MovementRow | null> {
    const remote: YieldPosition = await this.yieldProvider.fetchPosition();

    return this.db.runInSerializableTransaction(async (em) => {
      const local = await this.getCachedPositionInTx(em);
      const delta = remote.yieldEarnedUnits - local.yieldEarnedUnits;
      if (delta <= 0n) {
        // Still bump last_synced_at so observability tracks the heartbeat.
        await em.query(
          `UPDATE treasury_positions
              SET last_synced_at = NOW(), updated_at = NOW()
            WHERE provider = $1`,
          [this.yieldProvider.providerId],
        );
        return null;
      }

      const principal = await this.currentPrincipal(em);
      const today = new Date().toISOString().slice(0, 10);
      try {
        const row = await this.insertMovement(em, {
          direction: 'YIELD_ACCRUAL',
          amountUnits: delta,
          externalRef: `accrual-${this.yieldProvider.providerId}-${today}`,
          idempotencyKey: `yield-accrual-${today}`,
          runningBalanceUnits: principal,
        });
        await this.upsertPosition(em, principal, delta);
        return row;
      } catch (err: unknown) {
        // Unique violation (today's accrual already booked) is expected on
        // cron overlap — collapse silently.
        const code = (err as { code?: string })?.code;
        if (code === '23505') return null;
        throw err;
      }
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private assertPositive(amount: bigint): void {
    if (amount <= 0n) throw new InvalidAmountError(amount);
  }

  private async currentPrincipal(em: EntityManager): Promise<bigint> {
    const rows = await em.query<{ principal_units: string }[]>(
      `SELECT principal_units FROM treasury_positions WHERE provider = $1 LIMIT 1`,
      [this.yieldProvider.providerId],
    );
    return rows.length === 0 ? 0n : BigInt(rows[0].principal_units);
  }

  private async getCachedPositionInTx(em: EntityManager): Promise<{
    principalUnits: bigint;
    yieldEarnedUnits: bigint;
  }> {
    const rows = await em.query<
      { principal_units: string; yield_earned_units: string }[]
    >(
      `SELECT principal_units, yield_earned_units
         FROM treasury_positions
        WHERE provider = $1
        LIMIT 1`,
      [this.yieldProvider.providerId],
    );
    if (rows.length === 0) return { principalUnits: 0n, yieldEarnedUnits: 0n };
    return {
      principalUnits: BigInt(rows[0].principal_units),
      yieldEarnedUnits: BigInt(rows[0].yield_earned_units),
    };
  }

  private async findMovement(
    em: EntityManager,
    idempotencyKey: string,
  ): Promise<MovementRow | null> {
    const rows = await em.query<
      {
        id: string;
        direction: MovementDirection;
        amount_usdc_units: string;
        provider: string;
        external_ref: string | null;
        running_balance_units: string;
        created_at: Date;
      }[]
    >(
      `SELECT id, direction, amount_usdc_units, provider, external_ref,
              running_balance_units, created_at
         FROM treasury_movements
        WHERE provider = $1 AND idempotency_key = $2
        LIMIT 1`,
      [this.yieldProvider.providerId, idempotencyKey],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      direction: r.direction,
      amountUnits: BigInt(r.amount_usdc_units),
      provider: r.provider,
      externalRef: r.external_ref,
      runningBalanceUnits: BigInt(r.running_balance_units),
      createdAt: r.created_at,
    };
  }

  private async insertMovement(
    em: EntityManager,
    input: {
      direction: MovementDirection;
      amountUnits: bigint;
      externalRef: string;
      idempotencyKey: string;
      runningBalanceUnits: bigint;
    },
  ): Promise<MovementRow> {
    const rows = await em.query<
      {
        id: string;
        direction: MovementDirection;
        amount_usdc_units: string;
        provider: string;
        external_ref: string | null;
        running_balance_units: string;
        created_at: Date;
      }[]
    >(
      `INSERT INTO treasury_movements
         (direction, amount_usdc_units, provider, external_ref,
          idempotency_key, running_balance_units)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, direction, amount_usdc_units, provider, external_ref,
                 running_balance_units, created_at`,
      [
        input.direction,
        input.amountUnits.toString(),
        this.yieldProvider.providerId,
        input.externalRef,
        input.idempotencyKey,
        input.runningBalanceUnits.toString(),
      ],
    );
    const r = rows[0];
    return {
      id: r.id,
      direction: r.direction,
      amountUnits: BigInt(r.amount_usdc_units),
      provider: r.provider,
      externalRef: r.external_ref,
      runningBalanceUnits: BigInt(r.running_balance_units),
      createdAt: r.created_at,
    };
  }

  private async upsertPosition(
    em: EntityManager,
    principalUnits: bigint,
    yieldDeltaUnits: bigint,
  ): Promise<void> {
    await em.query(
      `INSERT INTO treasury_positions
         (provider, principal_units, yield_earned_units, last_synced_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (provider) DO UPDATE
         SET principal_units    = EXCLUDED.principal_units,
             yield_earned_units = treasury_positions.yield_earned_units + $3,
             last_synced_at     = NOW(),
             updated_at         = NOW()`,
      [this.yieldProvider.providerId, principalUnits.toString(), yieldDeltaUnits.toString()],
    );
  }
}
