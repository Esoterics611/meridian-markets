import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { DbService } from '@database/db.service';
import { AppConfig } from '@config/app-config.interface';
import {
  HEDGE_VENUE,
  HedgePosition,
  HedgePositionNotFoundError,
  IHedgeVenue,
} from './hedge-venue.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { InvalidHedgeAmountError } from './hedge.errors';

export type HedgeMovementDirection =
  | 'OPEN_SHORT'
  | 'CLOSE_SHORT'
  | 'FUNDING_ACCRUAL'
  | 'MARK_TO_MARKET';

export interface HedgeMovementRow {
  id: string;
  venue: string;
  direction: HedgeMovementDirection;
  notionalUnits: bigint;
  pnlUnits: bigint | null;
  fundingUnits: bigint | null;
  positionRef: string | null;
  externalRef: string;
  idempotencyKey: string;
  createdAt: Date;
}

// Raw DB shape — every numeric column comes back as string from pg driver.
interface RawMovementRow {
  id: string;
  venue: string;
  direction: string;
  notional_units: string;
  pnl_units: string | null;
  funding_units: string | null;
  position_ref: string | null;
  external_ref: string;
  idempotency_key: string;
  created_at: Date;
}

interface InsertMovementInput {
  direction: HedgeMovementDirection;
  notionalUnits: bigint;
  pnlUnits: bigint | null;
  fundingUnits: bigint | null;
  positionRef: string | null;
  externalRef: string;
  idempotencyKey: string;
}

function toMovementRow(raw: RawMovementRow): HedgeMovementRow {
  return {
    id: String(raw.id),
    venue: raw.venue,
    direction: raw.direction as HedgeMovementDirection,
    notionalUnits: BigInt(raw.notional_units),
    pnlUnits: raw.pnl_units != null ? BigInt(raw.pnl_units) : null,
    fundingUnits: raw.funding_units != null ? BigInt(raw.funding_units) : null,
    positionRef: raw.position_ref,
    externalRef: raw.external_ref,
    idempotencyKey: raw.idempotency_key,
    createdAt: new Date(raw.created_at),
  };
}

// HedgeService owns the append-only hedge ledger and the cached position state.
// Every state change runs in a SERIALIZABLE transaction with idempotency-key
// dedup at the (venue, idempotency_key) UNIQUE constraint.
//
// Pattern mirrors TreasuryService exactly: circuit breaker is consulted before
// the venue call; venue call happens before the DB transaction; DB transaction
// is the point of linearisation.
//
// NOTE: as flagged in SESSION_HISTORY.md §1 architectural note 5, the venue
// call runs before the DB transaction. A DB rollback after a successful venue
// open/close will leave the venue out of sync. This is the "partial failure"
// case. Replacing with a saga/outbox is flagged for Phase 1 hardening before
// any real-money flip.
@Injectable()
export class HedgeService {
  private readonly logger = new Logger(HedgeService.name);

  constructor(
    private readonly db: DbService,
    @Inject(HEDGE_VENUE) private readonly venue: IHedgeVenue,
    private readonly breaker: HedgeCircuitBreaker,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Opens a short-ILS position on the configured venue and persists the
   * movement + position cache row in a SERIALIZABLE transaction.
   *
   * The circuit breaker is checked first — if the venue is unhealthy or the
   * funding rate is spiking, we refuse to open and let the caller handle it.
   */
  async openShort(notionalUnits: bigint, idempotencyKey: string): Promise<HedgeMovementRow> {
    if (notionalUnits <= 0n) throw new InvalidHedgeAmountError(notionalUnits);

    // Circuit-breaker before the venue call — do not touch the venue if gates are tripped.
    const health = await this.venue.fetchHealth();
    this.breaker.checkVenueHealth(health);

    // Venue call outside the transaction (same posture as TreasuryService §deposit).
    const result = await this.venue.openShort({ notionalUnits, idempotencyKey });

    return this.db.runInSerializableTransaction(async (em) => {
      const existing = await this.findMovement(em, idempotencyKey);
      if (existing) return existing;

      const positionRef = result.externalRef;

      const row = await this.insertMovement(em, {
        direction: 'OPEN_SHORT',
        notionalUnits: result.filledNotionalUnits,
        pnlUnits: null,
        fundingUnits: null,
        positionRef,
        externalRef: result.externalRef,
        idempotencyKey,
      });

      await em.query(
        `INSERT INTO hedge_positions
           (position_ref, venue, notional_units, entry_price_micros, opened_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (position_ref) DO NOTHING`,
        [
          positionRef,
          this.venue.venueId,
          result.filledNotionalUnits.toString(),
          result.entryPriceMicros.toString(),
        ],
      );

      return row;
    });
  }

  /**
   * Closes an open short position and records the realised PnL.
   */
  async closeShort(positionRef: string, idempotencyKey: string): Promise<HedgeMovementRow> {
    // Venue call outside the transaction.
    const result = await this.venue.closeShort({ positionRef, idempotencyKey });

    return this.db.runInSerializableTransaction(async (em) => {
      const existing = await this.findMovement(em, idempotencyKey);
      if (existing) return existing;

      // Read the original notional to record the closing as a negative movement.
      const posRows = await em.query<{ notional_units: string }[]>(
        `SELECT notional_units FROM hedge_positions WHERE position_ref = $1 LIMIT 1`,
        [positionRef],
      );
      const originalNotional = posRows.length > 0 ? BigInt(posRows[0].notional_units) : 0n;

      const row = await this.insertMovement(em, {
        direction: 'CLOSE_SHORT',
        notionalUnits: -originalNotional,
        pnlUnits: result.pnlUnits,
        fundingUnits: null,
        positionRef,
        externalRef: result.externalRef,
        idempotencyKey,
      });

      await em.query(
        `UPDATE hedge_positions
            SET closed_at = NOW(), updated_at = NOW()
          WHERE position_ref = $1`,
        [positionRef],
      );

      return row;
    });
  }

  /**
   * Returns the current position state, preferring the DB cache. If the
   * cached row is older than `positionStalenessMs`, falls back to a live
   * venue fetch to get the current mark price.
   */
  async getPosition(positionRef: string): Promise<HedgePosition> {
    const app = this.cfg.getOrThrow<AppConfig>('app');

    const rows = await this.db.runInSerializableTransaction((em) =>
      em.query<
        {
          position_ref: string;
          notional_units: string;
          entry_price_micros: string;
          last_mark_micros: string | null;
          last_pnl_units: string | null;
          last_funding_units: string | null;
          closed_at: Date | null;
          updated_at: Date;
        }[]
      >(
        `SELECT position_ref, notional_units, entry_price_micros,
                last_mark_micros, last_pnl_units, last_funding_units,
                closed_at, updated_at
           FROM hedge_positions
          WHERE position_ref = $1
          LIMIT 1`,
        [positionRef],
      ),
    );

    if (rows.length === 0) throw new HedgePositionNotFoundError(positionRef);
    const cached = rows[0];

    // For open positions with a stale cache, fall back to live venue data.
    if (!cached.closed_at) {
      const ageMs = Date.now() - new Date(cached.updated_at).getTime();
      if (ageMs > app.hedge.positionStalenessMs) {
        return this.venue.fetchPosition(positionRef);
      }
    }

    const notional = BigInt(cached.notional_units);
    const entryMicros = BigInt(cached.entry_price_micros);
    const markMicros = cached.last_mark_micros ? BigInt(cached.last_mark_micros) : entryMicros;
    const unrealized = entryMicros > 0n
      ? (notional * (markMicros - entryMicros)) / entryMicros
      : 0n;
    const funding = cached.last_funding_units ? BigInt(cached.last_funding_units) : 0n;

    return {
      positionRef,
      notionalUnits: notional,
      entryPriceMicros: entryMicros,
      markPriceMicros: markMicros,
      unrealizedPnlUnits: unrealized,
      fundingPaidUnits: funding,
      asOf: new Date(cached.updated_at),
    };
  }

  /**
   * Sum of notional_units for all open (non-closed) positions on the configured venue.
   */
  async getTotalOpenNotional(): Promise<bigint> {
    const rows = await this.db.runInSerializableTransaction((em) =>
      em.query<{ total: string }[]>(
        `SELECT COALESCE(SUM(notional_units), 0)::text AS total
           FROM hedge_positions
          WHERE venue = $1 AND closed_at IS NULL`,
        [this.venue.venueId],
      ),
    );
    return BigInt(rows[0]?.total ?? '0');
  }

  /**
   * Returns the position_ref values for all open positions, ordered oldest-first.
   */
  async listOpenPositionRefs(): Promise<string[]> {
    const rows = await this.db.runInSerializableTransaction((em) =>
      em.query<{ position_ref: string }[]>(
        `SELECT position_ref
           FROM hedge_positions
          WHERE venue = $1 AND closed_at IS NULL
          ORDER BY opened_at ASC`,
        [this.venue.venueId],
      ),
    );
    return rows.map((r) => r.position_ref);
  }

  /**
   * Mark all open positions with the latest venue data. Writes one
   * MARK_TO_MARKET movement per position per calendar day (cron idempotency
   * via the partial unique index). Individual position failures are logged
   * and skipped so one bad position doesn't halt the others.
   */
  async markAll(): Promise<void> {
    const refs = await this.listOpenPositionRefs();
    for (const ref of refs) {
      try {
        await this.markPosition(ref);
      } catch (err: unknown) {
        this.logger.error(`markAll: failed to mark position ${ref}: ${(err as Error).message}`);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async markPosition(positionRef: string): Promise<void> {
    const live = await this.venue.fetchPosition(positionRef);
    const today = new Date().toISOString().slice(0, 10);

    await this.db.runInSerializableTransaction(async (em) => {
      try {
        await this.insertMovement(em, {
          direction: 'MARK_TO_MARKET',
          notionalUnits: live.notionalUnits,
          pnlUnits: live.unrealizedPnlUnits,
          fundingUnits: live.fundingPaidUnits,
          positionRef,
          externalRef: `mark-${positionRef}-${today}`,
          idempotencyKey: `mark-${positionRef}-${today}`,
        });
      } catch (err: unknown) {
        // Unique violation = already marked today; collapse silently.
        if ((err as { code?: string })?.code === '23505') return;
        throw err;
      }

      await em.query(
        `UPDATE hedge_positions
            SET last_mark_micros   = $2,
                last_pnl_units     = $3,
                last_funding_units = $4,
                updated_at         = NOW()
          WHERE position_ref = $1`,
        [
          positionRef,
          live.markPriceMicros.toString(),
          live.unrealizedPnlUnits.toString(),
          live.fundingPaidUnits.toString(),
        ],
      );
    });
  }

  private async findMovement(
    em: EntityManager,
    idempotencyKey: string,
  ): Promise<HedgeMovementRow | null> {
    const rows = await em.query<RawMovementRow[]>(
      `SELECT id, venue, direction, notional_units, pnl_units, funding_units,
              position_ref, external_ref, idempotency_key, created_at
         FROM hedge_movements
        WHERE venue = $1 AND idempotency_key = $2
        LIMIT 1`,
      [this.venue.venueId, idempotencyKey],
    );
    return rows.length === 0 ? null : toMovementRow(rows[0]);
  }

  private async insertMovement(
    em: EntityManager,
    input: InsertMovementInput,
  ): Promise<HedgeMovementRow> {
    const rows = await em.query<RawMovementRow[]>(
      `INSERT INTO hedge_movements
         (venue, direction, notional_units, pnl_units, funding_units,
          position_ref, external_ref, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, venue, direction, notional_units, pnl_units, funding_units,
                 position_ref, external_ref, idempotency_key, created_at`,
      [
        this.venue.venueId,
        input.direction,
        input.notionalUnits.toString(),
        input.pnlUnits?.toString() ?? null,
        input.fundingUnits?.toString() ?? null,
        input.positionRef ?? null,
        input.externalRef,
        input.idempotencyKey,
      ],
    );
    return toMovementRow(rows[0]);
  }
}
