import { Injectable } from '@nestjs/common';
import { DbService } from '@database/db.service';
import { StatArbBookRecord } from './stat-arb-state-store.interface';
import { StatArbBookState } from '../../execution/live-paper-trader';

// Raw-SQL repository for stat_arb_book_state — the mutable checkpoint cache (the
// analogue of MmStateRepository). TypeORM is a connection pool; migrations own
// the schema; no entity decorators. UPSERT on the TEXT primary key (book_key);
// soft-close via status. The P&L state + params ride as JSONB blobs (JSON-safe:
// all bigints are decimal strings).

interface StatArbBookStateRow {
  book_key: string;
  symbol_a: string;
  symbol_b: string;
  source: string | null;
  strategy_id: string;
  beta: number | null;
  params: Record<string, number> | null;
  notional_units: string;
  capital_units: string;
  running: boolean;
  state: StatArbBookState;
}

@Injectable()
export class StatArbStateRepository {
  constructor(private readonly db: DbService) {}

  /** Insert-or-update a book's config + state. A save marks it OPEN. */
  async upsert(r: StatArbBookRecord): Promise<void> {
    await this.db.runInSerializableTransaction(async (em) => {
      await em.query(
        `INSERT INTO stat_arb_book_state (
           book_key, symbol_a, symbol_b, source, strategy_id, beta, params,
           notional_units, capital_units, running, status, state, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, 'OPEN', $11, NOW()
         )
         ON CONFLICT (book_key) DO UPDATE SET
           symbol_a = EXCLUDED.symbol_a,
           symbol_b = EXCLUDED.symbol_b,
           source = EXCLUDED.source,
           strategy_id = EXCLUDED.strategy_id,
           beta = EXCLUDED.beta,
           params = EXCLUDED.params,
           notional_units = EXCLUDED.notional_units,
           capital_units = EXCLUDED.capital_units,
           running = EXCLUDED.running,
           status = 'OPEN',
           state = EXCLUDED.state,
           updated_at = NOW()`,
        [
          r.bookKey, r.symbolA, r.symbolB, r.source, r.strategyId, r.beta, r.params ? JSON.stringify(r.params) : null,
          r.notionalUnits.toString(), r.capitalUnits.toString(), r.running, JSON.stringify(r.state),
        ],
      );
    });
  }

  /** All OPEN books, oldest first, for boot rehydration. */
  async loadOpen(): Promise<StatArbBookRecord[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<StatArbBookStateRow[]>(
        `SELECT book_key, symbol_a, symbol_b, source, strategy_id, beta, params,
                notional_units, capital_units, running, state
         FROM stat_arb_book_state
         WHERE status = 'OPEN'
         ORDER BY created_at ASC`,
      );
      return rows.map((row) => coerce(row));
    });
  }

  /** Soft-close: keep the row + final P&L, stop rehydrating it. */
  async markClosed(bookKey: string): Promise<void> {
    await this.db.runInSerializableTransaction(async (em) => {
      await em.query(
        `UPDATE stat_arb_book_state SET status = 'CLOSED', running = FALSE, updated_at = NOW() WHERE book_key = $1`,
        [bookKey],
      );
    });
  }
}

/** Map a DB row → StatArbBookRecord (parse JSONB params/state; coerce BIGINT strings). */
function coerce(row: StatArbBookStateRow): StatArbBookRecord {
  const params = typeof row.params === 'string' ? (JSON.parse(row.params) as Record<string, number>) : row.params;
  const state = typeof row.state === 'string' ? (JSON.parse(row.state) as StatArbBookState) : row.state;
  return {
    bookKey: row.book_key,
    symbolA: row.symbol_a,
    symbolB: row.symbol_b,
    source: row.source,
    strategyId: row.strategy_id,
    beta: row.beta === null ? null : Number(row.beta),
    params: params ?? null,
    notionalUnits: BigInt(row.notional_units),
    capitalUnits: BigInt(row.capital_units),
    running: Boolean(row.running),
    state,
  };
}
