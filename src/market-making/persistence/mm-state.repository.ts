import { Injectable } from '@nestjs/common';
import { DbService } from '@database/db.service';
import { MmBookRecord } from './mm-state-store.interface';
import { MmBookState } from '../live/mm-book';

// Raw-SQL repository for mm_book_state — the mutable checkpoint cache. Same shape
// as StatArbRepository: TypeORM is a connection pool, migrations own the schema,
// no entity decorators. UPSERT on the TEXT primary key (book_key); soft-close via
// status. The P&L state + params ride as JSONB blobs (already JSON-safe).

interface MmBookStateRow {
  book_key: string;
  symbol: string;
  source: string | null;
  strategy_id: string;
  params: Record<string, number> | null;
  gamma: number;
  kappa: number;
  horizon_bars: number;
  vol_window_bars: number;
  vol_floor: number;
  maker_fee_bps: number;
  funding_rate_per_hour: number;
  quote_size_units: string;
  capital_units: string;
  running: boolean;
  state: MmBookState;
}

@Injectable()
export class MmStateRepository {
  constructor(private readonly db: DbService) {}

  /** Insert-or-update a book's config + state. A save marks it OPEN. */
  async upsert(r: MmBookRecord): Promise<void> {
    await this.db.runInSerializableTransaction(async (em) => {
      await em.query(
        `INSERT INTO mm_book_state (
           book_key, symbol, source, strategy_id, params,
           gamma, kappa, horizon_bars, vol_window_bars, vol_floor,
           maker_fee_bps, funding_rate_per_hour, quote_size_units, capital_units,
           running, status, state, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13, $14,
           $15, 'OPEN', $16, NOW()
         )
         ON CONFLICT (book_key) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           source = EXCLUDED.source,
           strategy_id = EXCLUDED.strategy_id,
           params = EXCLUDED.params,
           gamma = EXCLUDED.gamma,
           kappa = EXCLUDED.kappa,
           horizon_bars = EXCLUDED.horizon_bars,
           vol_window_bars = EXCLUDED.vol_window_bars,
           vol_floor = EXCLUDED.vol_floor,
           maker_fee_bps = EXCLUDED.maker_fee_bps,
           funding_rate_per_hour = EXCLUDED.funding_rate_per_hour,
           quote_size_units = EXCLUDED.quote_size_units,
           capital_units = EXCLUDED.capital_units,
           running = EXCLUDED.running,
           status = 'OPEN',
           state = EXCLUDED.state,
           updated_at = NOW()`,
        [
          r.bookKey, r.symbol, r.source, r.strategyId, r.params ? JSON.stringify(r.params) : null,
          r.gamma, r.kappa, r.horizonBars, r.volWindowBars, r.volFloor,
          r.makerFeeBps, r.fundingRatePerHour, r.quoteSizeUnits.toString(), r.capitalUnits.toString(),
          r.running, JSON.stringify(r.state),
        ],
      );
    });
  }

  /** All OPEN books, oldest first, for boot rehydration. */
  async loadOpen(): Promise<MmBookRecord[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<MmBookStateRow[]>(
        `SELECT book_key, symbol, source, strategy_id, params,
                gamma, kappa, horizon_bars, vol_window_bars, vol_floor,
                maker_fee_bps, funding_rate_per_hour, quote_size_units, capital_units,
                running, state
         FROM mm_book_state
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
        `UPDATE mm_book_state SET status = 'CLOSED', running = FALSE, updated_at = NOW() WHERE book_key = $1`,
        [bookKey],
      );
    });
  }
}

/** Map a DB row → MmBookRecord (parse JSONB params/state; coerce BIGINT strings). */
function coerce(row: MmBookStateRow): MmBookRecord {
  const params = typeof row.params === 'string' ? (JSON.parse(row.params) as Record<string, number>) : row.params;
  const state = typeof row.state === 'string' ? (JSON.parse(row.state) as MmBookState) : row.state;
  return {
    bookKey: row.book_key,
    symbol: row.symbol,
    source: row.source,
    strategyId: row.strategy_id,
    params: params ?? null,
    gamma: Number(row.gamma),
    kappa: Number(row.kappa),
    horizonBars: Number(row.horizon_bars),
    volWindowBars: Number(row.vol_window_bars),
    volFloor: Number(row.vol_floor),
    makerFeeBps: Number(row.maker_fee_bps),
    fundingRatePerHour: Number(row.funding_rate_per_hour),
    quoteSizeUnits: BigInt(row.quote_size_units),
    capitalUnits: BigInt(row.capital_units),
    running: Boolean(row.running),
    state,
  };
}
