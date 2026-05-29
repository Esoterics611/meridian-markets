import { Injectable } from '@nestjs/common';
import { DbService } from '@database/db.service';
import { Bar } from '../stat-arb/backtest/bar';

// Raw-SQL repository for market_bars + funding_rates + data_gaps. Same shape
// as StatArbRepository — DbService for connection pooling + serialisable
// transactions; no TypeORM entity decorators. The migration owns the schema.
//
// `pricesToMicros` converts the float-prices the synthetic feed produces
// into BIGINT-safe micros. Going the other way (`microsToPrice`) is used by
// the replay engine.

export interface MarketBarInsert {
  venue: string;
  symbol: string;
  bar: Bar;
}

export interface MarketBarRow {
  venue: string;
  symbol: string;
  ts: Date;
  openMicros: bigint;
  highMicros: bigint;
  lowMicros: bigint;
  closeMicros: bigint;
  volumeMicros: bigint;
}

export interface FundingRateInsert {
  venue: string;
  symbol: string;
  ts: Date;
  rateMicros: bigint;
}

export interface FundingRateRow extends FundingRateInsert {}

export interface DataGapInsert {
  venue: string;
  symbol: string;
  gapStart: Date;
  gapEnd: Date;
  missingBars: number;
}

export interface DataGapRow extends DataGapInsert {
  id: string;
  detectedAt: Date;
}

@Injectable()
export class MarketDataRepository {
  constructor(private readonly db: DbService) {}

  async insertBars(rows: MarketBarInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      let inserted = 0;
      for (const r of rows) {
        const result = await em.query<{ count: string }[]>(
          `INSERT INTO market_bars
             (venue, symbol, ts, open_micros, high_micros, low_micros, close_micros, volume_micros)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (venue, symbol, ts) DO NOTHING
           RETURNING 1 AS count`,
          [
            r.venue, r.symbol, r.bar.timestamp,
            priceToMicros(r.bar.open).toString(),
            priceToMicros(r.bar.high).toString(),
            priceToMicros(r.bar.low).toString(),
            priceToMicros(r.bar.close).toString(),
            priceToMicros(r.bar.volume).toString(),
          ],
        );
        if (result.length > 0) inserted++;
      }
      return inserted;
    });
  }

  async insertFunding(rows: FundingRateInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      let inserted = 0;
      for (const r of rows) {
        const result = await em.query<{ count: string }[]>(
          `INSERT INTO funding_rates (venue, symbol, ts, rate_micros)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (venue, symbol, ts) DO NOTHING
           RETURNING 1 AS count`,
          [r.venue, r.symbol, r.ts, r.rateMicros.toString()],
        );
        if (result.length > 0) inserted++;
      }
      return inserted;
    });
  }

  async insertGap(g: DataGapInsert): Promise<DataGapRow | null> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<DataGapRow[]>(
        `INSERT INTO data_gaps (venue, symbol, gap_start, gap_end, missing_bars)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (venue, symbol, gap_start) DO NOTHING
         RETURNING id, venue, symbol,
                   gap_start AS "gapStart", gap_end AS "gapEnd",
                   missing_bars AS "missingBars", detected_at AS "detectedAt"`,
        [g.venue, g.symbol, g.gapStart, g.gapEnd, g.missingBars],
      );
      if (rows.length === 0) return null;
      return { ...rows[0], missingBars: Number(rows[0].missingBars) };
    });
  }

  async barsBetween(venue: string, symbol: string, from: Date, to: Date): Promise<MarketBarRow[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<MarketBarRow[]>(
        `SELECT venue, symbol, ts,
                open_micros   AS "openMicros",
                high_micros   AS "highMicros",
                low_micros    AS "lowMicros",
                close_micros  AS "closeMicros",
                volume_micros AS "volumeMicros"
         FROM market_bars
         WHERE venue = $1 AND symbol = $2 AND ts >= $3 AND ts < $4
         ORDER BY ts ASC`,
        [venue, symbol, from, to],
      );
      return rows.map((r) => ({
        ...r,
        openMicros: BigInt(r.openMicros as unknown as string),
        highMicros: BigInt(r.highMicros as unknown as string),
        lowMicros: BigInt(r.lowMicros as unknown as string),
        closeMicros: BigInt(r.closeMicros as unknown as string),
        volumeMicros: BigInt(r.volumeMicros as unknown as string),
        ts: new Date(r.ts),
      }));
    });
  }

  /** All symbols that have at least one stored bar for the venue, ordered. */
  async distinctSymbols(venue: string): Promise<string[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<{ symbol: string }[]>(
        `SELECT DISTINCT symbol FROM market_bars WHERE venue = $1 ORDER BY symbol ASC`,
        [venue],
      );
      return rows.map((r) => r.symbol);
    });
  }

  /**
   * Load bars for many symbols in one window, keyed by symbol. Powers the
   * real-data discovery pipeline (replaces the synthetic universe). Symbols
   * with no bars in the window are simply absent from the map.
   */
  async barsForSymbols(
    venue: string,
    symbols: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, MarketBarRow[]>> {
    const out = new Map<string, MarketBarRow[]>();
    if (symbols.length === 0) return out;
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<MarketBarRow[]>(
        `SELECT venue, symbol, ts,
                open_micros   AS "openMicros",
                high_micros   AS "highMicros",
                low_micros    AS "lowMicros",
                close_micros  AS "closeMicros",
                volume_micros AS "volumeMicros"
         FROM market_bars
         WHERE venue = $1 AND symbol = ANY($2) AND ts >= $3 AND ts < $4
         ORDER BY symbol ASC, ts ASC`,
        [venue, symbols, from, to],
      );
      for (const r of rows) {
        const bucket = out.get(r.symbol) ?? [];
        bucket.push({
          ...r,
          openMicros: BigInt(r.openMicros as unknown as string),
          highMicros: BigInt(r.highMicros as unknown as string),
          lowMicros: BigInt(r.lowMicros as unknown as string),
          closeMicros: BigInt(r.closeMicros as unknown as string),
          volumeMicros: BigInt(r.volumeMicros as unknown as string),
          ts: new Date(r.ts),
        });
        out.set(r.symbol, bucket);
      }
      return out;
    });
  }

  async recentGaps(venue: string, symbol: string, limit = 20): Promise<DataGapRow[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<DataGapRow[]>(
        `SELECT id, venue, symbol,
                gap_start AS "gapStart", gap_end AS "gapEnd",
                missing_bars AS "missingBars", detected_at AS "detectedAt"
         FROM data_gaps
         WHERE venue = $1 AND symbol = $2
         ORDER BY detected_at DESC
         LIMIT $3`,
        [venue, symbol, limit],
      );
      return rows.map((r) => ({
        ...r,
        missingBars: Number(r.missingBars),
        gapStart: new Date(r.gapStart),
        gapEnd: new Date(r.gapEnd),
        detectedAt: new Date(r.detectedAt),
      }));
    });
  }
}

const SCALE = 1_000_000;
export function priceToMicros(p: number): bigint {
  if (!Number.isFinite(p) || p < 0) return 0n;
  return BigInt(Math.round(p * SCALE));
}
export function microsToPrice(m: bigint): number {
  return Number(m) / SCALE;
}

/** Hydrate a MarketBarRow back into the in-memory Bar shape used by the backtest. */
export function rowToBar(r: MarketBarRow): Bar {
  return {
    symbol: r.symbol,
    timestamp: r.ts,
    open: microsToPrice(r.openMicros),
    high: microsToPrice(r.highMicros),
    low: microsToPrice(r.lowMicros),
    close: microsToPrice(r.closeMicros),
    volume: microsToPrice(r.volumeMicros),
  };
}
