import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DbService } from '@database/db.service';

// Raw-SQL repository for stat_arb_trades + stat_arb_nav. Same shape as
// TreasuryService's append-only inserts — TypeORM is used purely as a
// connection pool; no entity decorators. Migrations own the schema.

export interface StatArbTradeInsert {
  venue: string;
  symbolA: string;
  symbolB: string;
  side: 'LONG' | 'SHORT';
  entryZ: number;
  exitZ: number;
  entryPriceAMicros: bigint;
  entryPriceBMicros: bigint;
  exitPriceAMicros: bigint;
  exitPriceBMicros: bigint;
  notionalUnits: bigint;
  pnlUnits: bigint;
  feesUnits: bigint;
  openedAt: Date;
  closedAt: Date;
  idempotencyKey: string;
}

export interface StatArbTradeRow extends StatArbTradeInsert {
  id: string;
  createdAt: Date;
}

export interface StatArbNavInsert {
  asOf: Date;
  navUnits: bigint;
  openPositionCount: number;
}

export interface StatArbNavRow extends StatArbNavInsert {
  id: string;
  createdAt: Date;
}

@Injectable()
export class StatArbRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a closed trade. Replay-safe: `(venue, idempotency_key)` UNIQUE. */
  async insertTrade(t: StatArbTradeInsert): Promise<StatArbTradeRow> {
    return this.db.runInSerializableTransaction(async (em) => {
      const existing = await this.findTradeByKey(em, t.venue, t.idempotencyKey);
      if (existing) return existing;
      const rows = await em.query<StatArbTradeRow[]>(
        `INSERT INTO stat_arb_trades (
           venue, symbol_a, symbol_b, side,
           entry_z, exit_z,
           entry_price_a_micros, entry_price_b_micros,
           exit_price_a_micros, exit_price_b_micros,
           notional_units, pnl_units, fees_units,
           opened_at, closed_at, idempotency_key
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6,
           $7, $8,
           $9, $10,
           $11, $12, $13,
           $14, $15, $16
         )
         RETURNING id, venue, symbol_a AS "symbolA", symbol_b AS "symbolB", side,
                   entry_z AS "entryZ", exit_z AS "exitZ",
                   entry_price_a_micros AS "entryPriceAMicros",
                   entry_price_b_micros AS "entryPriceBMicros",
                   exit_price_a_micros AS "exitPriceAMicros",
                   exit_price_b_micros AS "exitPriceBMicros",
                   notional_units AS "notionalUnits",
                   pnl_units AS "pnlUnits",
                   fees_units AS "feesUnits",
                   opened_at AS "openedAt", closed_at AS "closedAt",
                   idempotency_key AS "idempotencyKey", created_at AS "createdAt"`,
        [
          t.venue, t.symbolA, t.symbolB, t.side,
          t.entryZ, t.exitZ,
          t.entryPriceAMicros.toString(), t.entryPriceBMicros.toString(),
          t.exitPriceAMicros.toString(), t.exitPriceBMicros.toString(),
          t.notionalUnits.toString(), t.pnlUnits.toString(), t.feesUnits.toString(),
          t.openedAt, t.closedAt, t.idempotencyKey,
        ],
      );
      return this.coerceTrade(rows[0]);
    });
  }

  /** Insert a NAV snapshot for the given UTC day. Idempotent per day. */
  async insertNav(n: StatArbNavInsert): Promise<StatArbNavRow | null> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<StatArbNavRow[]>(
        `INSERT INTO stat_arb_nav (as_of, nav_units, open_position_count)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, as_of AS "asOf", nav_units AS "navUnits",
                   open_position_count AS "openPositionCount", created_at AS "createdAt"`,
        [n.asOf, n.navUnits.toString(), n.openPositionCount],
      );
      if (rows.length === 0) return null;
      return this.coerceNav(rows[0]);
    });
  }

  async recentTrades(venue: string, limit = 50): Promise<StatArbTradeRow[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<StatArbTradeRow[]>(
        `SELECT id, venue, symbol_a AS "symbolA", symbol_b AS "symbolB", side,
                entry_z AS "entryZ", exit_z AS "exitZ",
                entry_price_a_micros AS "entryPriceAMicros",
                entry_price_b_micros AS "entryPriceBMicros",
                exit_price_a_micros AS "exitPriceAMicros",
                exit_price_b_micros AS "exitPriceBMicros",
                notional_units AS "notionalUnits",
                pnl_units AS "pnlUnits",
                fees_units AS "feesUnits",
                opened_at AS "openedAt", closed_at AS "closedAt",
                idempotency_key AS "idempotencyKey", created_at AS "createdAt"
         FROM stat_arb_trades
         WHERE venue = $1
         ORDER BY closed_at DESC
         LIMIT $2`,
        [venue, limit],
      );
      return rows.map((r) => this.coerceTrade(r));
    });
  }

  async navHistory(fromAsOf: Date): Promise<StatArbNavRow[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<StatArbNavRow[]>(
        `SELECT id, as_of AS "asOf", nav_units AS "navUnits",
                open_position_count AS "openPositionCount", created_at AS "createdAt"
         FROM stat_arb_nav
         WHERE as_of >= $1
         ORDER BY as_of ASC`,
        [fromAsOf],
      );
      return rows.map((r) => this.coerceNav(r));
    });
  }

  private async findTradeByKey(em: EntityManager, venue: string, key: string): Promise<StatArbTradeRow | null> {
    const rows = await em.query<StatArbTradeRow[]>(
      `SELECT id, venue, symbol_a AS "symbolA", symbol_b AS "symbolB", side,
              entry_z AS "entryZ", exit_z AS "exitZ",
              entry_price_a_micros AS "entryPriceAMicros",
              entry_price_b_micros AS "entryPriceBMicros",
              exit_price_a_micros AS "exitPriceAMicros",
              exit_price_b_micros AS "exitPriceBMicros",
              notional_units AS "notionalUnits",
              pnl_units AS "pnlUnits",
              fees_units AS "feesUnits",
              opened_at AS "openedAt", closed_at AS "closedAt",
              idempotency_key AS "idempotencyKey", created_at AS "createdAt"
       FROM stat_arb_trades
       WHERE venue = $1 AND idempotency_key = $2
       LIMIT 1`,
      [venue, key],
    );
    return rows.length ? this.coerceTrade(rows[0]) : null;
  }

  /** Coerces driver-returned numeric strings into bigints. */
  private coerceTrade(r: StatArbTradeRow): StatArbTradeRow {
    return {
      ...r,
      entryPriceAMicros: BigInt(r.entryPriceAMicros as unknown as string),
      entryPriceBMicros: BigInt(r.entryPriceBMicros as unknown as string),
      exitPriceAMicros: BigInt(r.exitPriceAMicros as unknown as string),
      exitPriceBMicros: BigInt(r.exitPriceBMicros as unknown as string),
      notionalUnits: BigInt(r.notionalUnits as unknown as string),
      pnlUnits: BigInt(r.pnlUnits as unknown as string),
      feesUnits: BigInt(r.feesUnits as unknown as string),
      openedAt: new Date(r.openedAt),
      closedAt: new Date(r.closedAt),
      createdAt: new Date(r.createdAt),
    };
  }

  private coerceNav(r: StatArbNavRow): StatArbNavRow {
    return {
      ...r,
      navUnits: BigInt(r.navUnits as unknown as string),
      openPositionCount: Number(r.openPositionCount),
      asOf: new Date(r.asOf),
      createdAt: new Date(r.createdAt),
    };
  }

}
