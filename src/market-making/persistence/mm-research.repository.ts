import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '@database/db.service';
import { DeskEvent } from '../events/desk-event';
import { ResolvedMarkout } from '../microstructure/markout-tracker';
import { HedgeSnapshot } from '../hedge/desk-hedge-controller';

// MmResearchRepository — raw-SQL writer for the F0 research tables (Journal #58):
// mm_fill_markout, mm_hedge_nav, mm_hedge_quality, mm_desk_event. Same posture as
// MmNavRepository: TypeORM is a connection pool, migrations own the schema, money
// in 6-dec units (BIGINT), append-only at the privilege layer.
//
// The two high-rate streams (per-fill markouts, desk events) are fed through
// BufferedSink — a bounded buffer + interval flush — so persistence adds zero
// latency to the quoting/marking path and a DB hiccup degrades to dropped
// research rows + an error log, never a broken tick (DC-5).

export interface FillMarkoutInsert {
  ts: Date;
  bookKey: string;
  source: string;
  side: 'BUY' | 'SELL';
  priceMicros: bigint;
  sizeUnits: bigint;
  notionalUnits: bigint;
  fairMidMicros: bigint;
  horizonMs: number;
  markoutBps: number;
  flow: number | null;
  vpin: number | null;
  sigma: number | null;
  inventoryUnitsBefore: bigint;
  queueAheadUnits: bigint | null;
}

/** Map one resolved markout observation (+ book identity) onto an insert row. */
export function fillMarkoutRow(bookKey: string, source: string, r: ResolvedMarkout): FillMarkoutInsert {
  const size = r.meta?.sizeUnits ?? 0n;
  const price = r.meta?.priceMicros ?? r.fairMidMicros;
  return {
    ts: new Date(r.tFillMs),
    bookKey,
    source,
    side: r.side,
    priceMicros: price,
    sizeUnits: size,
    notionalUnits: (size * price) / 1_000_000n,
    fairMidMicros: r.fairMidMicros,
    horizonMs: r.horizonMs,
    markoutBps: r.bps,
    flow: r.meta?.flow ?? null,
    vpin: r.meta?.vpin ?? null,
    sigma: r.meta?.sigma ?? null,
    inventoryUnitsBefore: r.meta?.inventoryUnitsBefore ?? 0n,
    queueAheadUnits: r.meta?.queueAheadUnits ?? null,
  };
}

@Injectable()
export class MmResearchRepository {
  constructor(private readonly db: DbService) {}

  async insertFillMarkouts(rows: FillMarkoutInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      const cols = 15;
      const ph: string[] = [];
      const params: unknown[] = [];
      rows.forEach((r, i) => {
        const b = i * cols;
        ph.push(`(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(', ')})`);
        params.push(
          r.ts, r.bookKey, r.source, r.side,
          r.priceMicros.toString(), r.sizeUnits.toString(), r.notionalUnits.toString(), r.fairMidMicros.toString(),
          r.horizonMs, r.markoutBps, r.flow, r.vpin, r.sigma,
          r.inventoryUnitsBefore.toString(), r.queueAheadUnits === null ? null : r.queueAheadUnits.toString(),
        );
      });
      const res = await em.query<{ id: string }[]>(
        `INSERT INTO mm_fill_markout (
           ts, book_key, source, side, price_micros, size_units, notional_units, fair_mid_micros,
           horizon_ms, markout_bps, flow, vpin, sigma, inventory_units_before, queue_ahead_units
         ) VALUES ${ph.join(', ')} RETURNING id`,
        params,
      );
      return res.length;
    });
  }

  async insertDeskEvents(rows: DeskEvent[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      const cols = 8;
      const ph: string[] = [];
      const params: unknown[] = [];
      rows.forEach((e, i) => {
        const b = i * cols;
        ph.push(`(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(', ')})`);
        const { seq, ts, desk, kind, book, source, message, ...rest } = e;
        params.push(seq, new Date(ts), desk, kind, book, source, message, Object.keys(rest).length ? JSON.stringify(rest) : null);
      });
      const res = await em.query<{ id: string }[]>(
        `INSERT INTO mm_desk_event (seq, ts, desk, kind, book_key, source, message, payload)
         VALUES ${ph.join(', ')} RETURNING id`,
        params,
      );
      return res.length;
    });
  }

  /** Persist one hedge snapshot: a per-leg mm_hedge_nav row set (every interval). */
  async insertHedgeNav(asOf: Date, hedge: HedgeSnapshot): Promise<number> {
    const legs = hedge.perUnderlying.filter((u) => u.hedgeUnits !== 0 || u.netDeltaUsd !== 0);
    if (legs.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      const cols = 10;
      const ph: string[] = [];
      const params: unknown[] = [];
      legs.forEach((u, i) => {
        const b = i * cols;
        ph.push(`(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(', ')})`);
        params.push(
          asOf, u.underlying,
          BigInt(Math.round(u.hedgeUnits * 1_000_000)).toString(),
          BigInt(Math.round(u.markUsd ? u.markUsd * 1_000_000 : 0)).toString(),
          u.hedgeNotionalUsd, u.netDeltaUsd, u.residualUsd,
          u.pnlUsd ?? 0, u.fundingUsd ?? 0, u.feesUsd ?? 0,
        );
      });
      const res = await em.query<{ id: string }[]>(
        `INSERT INTO mm_hedge_nav (as_of, underlying, units, mark_micros, notional_usd,
           net_delta_usd, residual_usd, pnl_usd, funding_usd, fees_usd)
         VALUES ${ph.join(', ')} RETURNING id`,
        params,
      );
      return res.length;
    });
  }

  /** Persist the hedge-quality KPI per book (hourly + shutdown — the DR-2 closure). */
  async insertHedgeQuality(asOf: Date, hedge: HedgeSnapshot): Promise<number> {
    const books = hedge.quality?.perBook ?? [];
    if (books.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      const cols = 8;
      const ph: string[] = [];
      const params: unknown[] = [];
      books.forEach((q, i) => {
        const b = i * cols;
        ph.push(`(${Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(', ')})`);
        params.push(asOf, q.symbol, q.underlying, q.betaCfg, q.betaLive, q.r2, q.basisShare, q.pnlVolUsdPerHour);
      });
      const res = await em.query<{ id: string }[]>(
        `INSERT INTO mm_hedge_quality (as_of, book_key, underlying, beta_cfg, beta_live, r2, basis_share, pnl_vol_usd_hr)
         VALUES ${ph.join(', ')} RETURNING id`,
        params,
      );
      return res.length;
    });
  }
}

/** DI token for the live MmResearchSinks pair (null when MM_PERSIST is off / no DB). */
export const MM_RESEARCH_SINKS = Symbol('MM_RESEARCH_SINKS');

/**
 * MmResearchSinks — the two live BufferedSinks (per-fill markouts, desk events) over one
 * MmResearchRepository. Owns their lifecycle: started at construction, stopped + final-flushed
 * on module destroy (so a finished run's tail rows land before the process exits).
 */
export class MmResearchSinks {
  readonly fills: BufferedSink<FillMarkoutInsert>;
  readonly events: BufferedSink<DeskEvent>;

  constructor(repo: MmResearchRepository) {
    this.fills = new BufferedSink((rows) => repo.insertFillMarkouts(rows), 'fill-markout');
    this.events = new BufferedSink((rows) => repo.insertDeskEvents(rows), 'desk-event');
    this.fills.start();
    this.events.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.fills.stop();
    this.events.stop();
    await this.fills.flush();
    await this.events.flush();
  }
}

/**
 * BufferedSink — a bounded buffer + interval flush for the high-rate research streams.
 * enqueue() is synchronous and O(1) (never blocks a tick); the timer drains in batches.
 * On overflow the OLDEST rows drop (research data degrades, live trading never does).
 * flush() is exposed for shutdown + tests; stop() clears the timer.
 */
export class BufferedSink<T> {
  private readonly logger = new Logger('MmResearchSink');
  private buf: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private readonly write: (rows: T[]) => Promise<number>,
    private readonly label: string,
    private readonly flushMs = 5_000,
    private readonly maxBuffer = 5_000,
    private readonly maxBatch = 500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(row: T): void {
    this.buf.push(row);
    if (this.buf.length > this.maxBuffer) this.buf.splice(0, this.buf.length - this.maxBuffer);
  }

  size(): number {
    return this.buf.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buf.length === 0) return;
    this.flushing = true;
    try {
      while (this.buf.length > 0) {
        const batch = this.buf.splice(0, this.maxBatch);
        await this.write(batch);
      }
    } catch (e) {
      // Best-effort: log + drop the failed batch's siblings stay buffered for the next tick.
      this.logger.error(`${this.label} flush failed: ${(e as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }
}
