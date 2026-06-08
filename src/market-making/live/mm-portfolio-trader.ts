import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { MmBook, MmBookSnapshot } from './mm-book';
import { DeskHedgeController, HedgeSnapshot } from '../hedge/desk-hedge-controller';
import { BookDelta } from '../hedge/desk-delta-hedger';
import { IMmStateStore, MmBookRecord } from '../persistence/mm-state-store.interface';
import { NullMmStateStore } from '../persistence/null-mm-state-store';
import { ITelemetry } from '../../telemetry/telemetry.interface';
import { NULL_TELEMETRY } from '../../telemetry/null-telemetry';
import { M } from '../../telemetry/metric-catalog';
import { IDeskEventSink, NULL_DESK_EVENT_SINK } from '../events/desk-event-sink';
import { lifecycleEvent } from '../events/desk-event';

// MmPortfolioTrader — the multi-book generalisation of MmBook, the market-making
// twin of LivePortfolioTrader. Runs N single-instrument MM books concurrently on
// the live feed, each with its own inventory, quoter and isolated paper P&L. One
// timer ticks every book; the snapshot aggregates desk-level equity/P&L and a
// per-book breakdown. This is what lets automated MM books run *next to* the
// stat-arb portfolio — same control-plane shape (launch / remove / start / stop /
// flatten / snapshot), different strategy family.

export interface MmBookSpec {
  symbol: string;
  /** MM strategy catalogue id (mmStrategyRegistry). Defaults to the config default. */
  strategyId?: string;
  /** Per-launch overrides of the quoter's frozen params (e.g. { gamma, kappa }). */
  params?: Record<string, number>;
  /**
   * Reference data source id (e.g. 'geckoterminal') for a DEX / decentralized
   * book; omit for the default Binance feed. The book factory resolves this to a
   * `ReferenceBarFeed` so a DEX pool quotes on the SAME live loop as a Binance
   * instrument — the MM twin of `PortfolioPair.source` (S20).
   */
  source?: string;
  /**
   * Quote size in DOLLAR notional. The factory sizes `quoteSizeUnits = notional ÷
   * price` so a high-priced perp ($66k) isn't over-sized by the fixed unit default
   * (notional-sizing.ts). Omit to keep the config's fixed `quoteSizeUnits`.
   */
  quoteNotionalUsd?: number;
}

// The factory may probe the live price to size by notional, so it can be async.
// A sync factory (the unit tests) still satisfies the union — addBook awaits either.
export type MmBookFactory = (spec: MmBookSpec) => MmBook | Promise<MmBook>;

// Rebuilds a book from a persisted record on boot (restart-safe books): the module
// constructs the quoter/feed/risk gate from the record's CONFIG using its exact
// resolved values (not re-derived), and the trader restores the P&L state onto it.
export type MmBookRebuilder = (record: MmBookRecord) => Promise<MmBook>;

export interface MmPortfolioPersistence {
  store?: IMmStateStore;
  rebuildBook?: MmBookRebuilder;
  /** Close every book's inventory before the final checkpoint on shutdown. */
  flattenOnShutdown?: boolean;
}

export interface MmPortfolioSnapshot {
  running: boolean;
  bookCount: number;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  feesUnits: string;
  /** Desk-total funding accrued on held perp inventory (+ received / − paid). */
  fundingUnits: string;
  netPnlUnits: string;
  books: MmBookSnapshot[];
  /** Desk delta-hedge state (gross delta / post-hedge residual / hedge P&L), when enabled. */
  hedge?: HedgeSnapshot;
}

export class MmPortfolioTrader implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MmPortfolioTrader.name);
  private readonly books = new Map<string, MmBook>();
  /** Per-book launch spec (source + params), kept so a book can be re-persisted. */
  private readonly specs = new Map<string, MmBookSpec>();
  private capitalUnits: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The fast-path L2 poll driver (C2), wired post-construction via setFastDriver. */
  private fastDriver: { start(): void; stop(): void } | null = null;
  private ticking = false;
  /** Epoch ms of the last completed tick (readiness probe); null until first tick. */
  private lastTickAtMs: number | null = null;
  private readonly store: IMmStateStore;
  private readonly rebuildBook?: MmBookRebuilder;
  private readonly flattenOnShutdown: boolean;

  constructor(
    private readonly makeBook: MmBookFactory,
    private readonly pollIntervalMs: number,
    initialCapitalUnits = 100_000_000_000n,
    persistence: MmPortfolioPersistence = {},
    // Observability seam: NullTelemetry by default ⇒ no behaviour change + the unit
    // tests construct the trader unchanged. The module injects the real telemetry.
    private readonly telemetry: ITelemetry = NULL_TELEMETRY,
    // Business-event sink (launch / remove / start / stop). No-op default ⇒ the
    // unit tests are unchanged; the module injects the shared DeskEventLog so these
    // lifecycle events land in the same log + activity feed as the per-book fills.
    private readonly events: IDeskEventSink = NULL_DESK_EVENT_SINK,
    // Desk delta hedge (HEDGING_MODEL.md). undefined ⇒ off (every existing test constructs the
    // trader without it and is unchanged). The module injects it when MM_DELTA_HEDGE=true.
    private readonly hedger?: DeskHedgeController,
  ) {
    this.capitalUnits = initialCapitalUnits;
    this.store = persistence.store ?? new NullMmStateStore();
    this.rebuildBook = persistence.rebuildBook;
    this.flattenOnShutdown = persistence.flattenOnShutdown ?? false;
  }

  /** epoch ms of the last hedge rebalance, for funding/dt accrual. */
  private lastHedgeMs: number | null = null;

  /** Per-underlying book deltas + marks for the hedge, read off the live book snapshots. */
  private deskDeltas(): { books: BookDelta[]; prices: Record<string, bigint> } {
    const books: BookDelta[] = [];
    const prices: Record<string, bigint> = {};
    for (const b of this.books.values()) {
      const s = b.snapshot();
      const midMicros = BigInt(s.midMicros);
      if (midMicros <= 0n) continue; // un-warm book has no mark yet
      books.push({ symbol: s.symbol, inventoryUnits: BigInt(s.inventoryUnits), midMicros });
      prices[s.symbol] = midMicros;
    }
    return { books, prices };
  }

  /** Epoch ms of the last completed tick (or null) — the readiness freshness probe. */
  lastTickAt(): number | null {
    return this.lastTickAtMs;
  }

  /** The loop's configured poll cadence (ms) — readiness compares tick age to N×this. */
  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /** Boot: rehydrate persisted OPEN books (restart-safe). Stopped until start(). */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.store.enabled || !this.rebuildBook) return;
    const records = await this.store.loadOpen().catch((e) => {
      this.logger.error(`mm rehydrate load failed: ${(e as Error).message}`);
      return [] as MmBookRecord[];
    });
    for (const rec of records) {
      try {
        const book = await this.rebuildBook(rec);
        book.restore(rec.state); // carry forward inventory + P&L
        await book.warmup(); // re-seed σ from recent closes
        book.setRunning(false);
        this.books.set(rec.bookKey, book);
        this.specs.set(rec.bookKey, { symbol: rec.symbol, strategyId: rec.strategyId, source: rec.source ?? undefined, params: rec.params ?? undefined });
      } catch (e) {
        this.logger.error(`mm rehydrate ${rec.bookKey} failed: ${(e as Error).message}`);
      }
    }
    this.telemetry.gauge(M.persistRehydratedBooks, this.books.size);
    if (this.books.size) this.logger.log(`rehydrated ${this.books.size} mm book(s) from persistence — start the desk to resume quoting`);
  }

  /** Shutdown: optionally flatten, then checkpoint final state (a real company's books). */
  async onApplicationShutdown(): Promise<void> {
    this.stop();
    if (this.flattenOnShutdown) await this.flattenAll();
    await this.checkpointAll();
  }

  /**
   * Launch ONE additional MM book without disturbing the others — the human
   * "run a quoter on this instrument" action. Builds an isolated book, warms its
   * σ window, gives it its own capital, and adds it; if the loop is running it
   * starts ticking next interval. Replaces any existing book on the same symbol.
   */
  async addBook(spec: MmBookSpec, capitalUnits: bigint): Promise<void> {
    if (capitalUnits <= 0n) throw new Error('launch capital must be positive');
    const book = await this.makeBook(spec);
    book.setCapital(capitalUnits);
    await book.warmup();
    book.setRunning(this.isRunning());
    this.books.set(spec.symbol, book);
    this.specs.set(spec.symbol, spec);
    await this.persist(spec.symbol); // durable from launch
    this.events.emit(
      lifecycleEvent({
        ts: Date.now(),
        kind: 'launch',
        book: spec.symbol,
        source: spec.source ?? '',
        message: `launched ${spec.symbol} via ${spec.strategyId ?? 'default'} (capital ${(capitalUnits / 1_000_000n).toString()} USDC)`,
      }),
    );
  }

  /** Stop + remove one book: flatten its inventory, then drop it (soft-close in the store). */
  async removeBook(symbol: string): Promise<boolean> {
    const b = this.books.get(symbol);
    if (!b) return false;
    await b.flatten().catch(() => undefined);
    await this.persist(symbol); // checkpoint the flattened state before closing
    this.books.delete(symbol);
    this.specs.delete(symbol);
    if (this.store.enabled) await this.store.close(symbol).catch((e) => this.logger.error(`mm close ${symbol}: ${(e as Error).message}`));
    this.events.emit(lifecycleEvent({ ts: Date.now(), kind: 'remove', book: symbol, message: `removed ${symbol} (flattened + dropped)` }));
    if (this.books.size === 0) this.stop();
    return true;
  }

  async flattenAll(): Promise<void> {
    await Promise.all([...this.books.values()].map((b) => b.flatten().catch(() => undefined)));
  }

  start(): void {
    if (this.timer || this.books.size === 0) return;
    for (const b of this.books.values()) b.setRunning(true);
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.fastDriver?.start(); // the sub-second L2 poll loop for fast-path books (C2)
    this.events.emit(lifecycleEvent({ ts: Date.now(), kind: 'start', message: `desk loop started — ${this.books.size} book(s) quoting every ${this.pollIntervalMs}ms` }));
  }

  stop(): void {
    const wasRunning = this.timer !== null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.fastDriver?.stop();
    for (const b of this.books.values()) b.setRunning(false);
    if (wasRunning) this.events.emit(lifecycleEvent({ ts: Date.now(), kind: 'stop', message: 'desk loop stopped' }));
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Wire the fast-path L2 poll driver (C2). The module builds it after the trader (the
   *  driver's sink routes back here), then hands it over; start()/stop() drive it. */
  setFastDriver(driver: { start(): void; stop(): void } | null): void {
    this.fastDriver = driver;
  }

  /** Symbols of the live fast-path books — the driver polls these (resolved each cycle
   *  so books launched/removed at runtime are tracked). */
  fastPathSymbols(): string[] {
    const out: string[] = [];
    for (const [key, b] of this.books) if (b.isFastPath()) out.push(this.specs.get(key)?.symbol ?? key);
    return out;
  }

  /** The poll driver's sink: route one symbol's L2 snapshot to its book. Best-effort —
   *  one book's error never sinks the loop (mirrors the bar tick's per-book guard). */
  routeL2Snapshot(symbol: string, tick: import('./l2-fill-engine-types').LiveTick): void {
    const book = this.books.get(symbol);
    if (!book) return;
    try {
      book.onL2Snapshot(tick);
    } catch (e) {
      this.logger.error(`mm fast-path error for ${symbol}: ${(e as Error).message}`);
    }
  }

  /**
   * Refresh each book's perp funding rate from a source fn `(symbol, source) → rate`
   * (signed fraction/hour) or `null` to leave a book unchanged (e.g. a spot/AMM book
   * with no funding). Lets the FundingRefreshCron keep the static-at-launch carry
   * rate current as funding drifts over a multi-hour run (mm-book.setFundingRatePerHour
   * is the per-book hook). Best-effort: a single book's refresh error never aborts the
   * sweep. Returns the number of books actually updated. (MM course §8.10.)
   */
  async refreshFunding(rateFor: (symbol: string, source: string | undefined) => Promise<number | null>): Promise<number> {
    let updated = 0;
    for (const [key, book] of this.books) {
      const spec = this.specs.get(key);
      try {
        const rate = await rateFor(spec?.symbol ?? key, spec?.source);
        if (rate !== null && Number.isFinite(rate)) {
          book.setFundingRatePerHour(rate);
          updated += 1;
        }
      } catch (e) {
        this.logger.warn(`funding refresh failed for ${key}: ${(e as Error).message}`);
      }
    }
    return updated;
  }

  /** One iteration: tick every book. Never throws — a single book's error is logged. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startMs = Date.now();
    try {
      await Promise.all(
        // Coexistence rule: fast-path (L2) books are driven by the poll driver via
        // routeL2Snapshot(), NOT the bar timer — never tick a book on both paths.
        [...this.books.values()]
          .filter((b) => !b.isFastPath())
          .map((b) => b.tick().catch((e) => this.logger.error(`mm book tick error: ${(e as Error).message}`))),
      );
      await this.checkpointAll(); // durable P&L after every tick (no-op when persistence is off)
      if (this.hedger) {
        // Delta hedge AFTER the books tick (so we hedge this tick's inventory). Best-effort —
        // a hedge error never sinks the loop (mirrors the per-book guard above).
        try {
          const { books, prices } = this.deskDeltas();
          const now = Date.now();
          const dtHours = this.lastHedgeMs ? (now - this.lastHedgeMs) / 3_600_000 : 0;
          this.lastHedgeMs = now;
          await this.hedger.rebalance(books, { prices, dtHours });
        } catch (e) {
          this.logger.error(`mm delta-hedge error: ${(e as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
      const durSec = (Date.now() - startMs) / 1000;
      this.lastTickAtMs = Date.now();
      this.telemetry.counter(M.tick, { loop: 'mm' });
      this.telemetry.histogram(M.tickDuration, durSec, { loop: 'mm' });
      // A tick that runs longer than the poll interval is a first-class signal
      // (the loop can't keep cadence) — count it and raise a uniform alert (FR-2/10).
      if (durSec * 1000 > this.pollIntervalMs) {
        this.telemetry.counter(M.tickOverrun, { loop: 'mm' });
        this.telemetry.alert({ kind: 'tick_overrun', severity: 'warn', message: `mm tick ${Math.round(durSec * 1000)}ms exceeded poll ${this.pollIntervalMs}ms` });
      }
    }
  }

  /** Build the durable record for one book (config + live P&L state). */
  private recordFor(symbol: string): MmBookRecord | null {
    const book = this.books.get(symbol);
    const spec = this.specs.get(symbol);
    if (!book || !spec) return null;
    const c = book.config();
    return {
      bookKey: symbol,
      symbol,
      source: spec.source ?? null,
      strategyId: c.strategyId,
      params: spec.params ?? null,
      gamma: c.gamma,
      kappa: c.kappa,
      horizonBars: c.horizonBars,
      volWindowBars: c.volWindowBars,
      volFloor: c.volFloor,
      makerFeeBps: c.makerFeeBps,
      fundingRatePerHour: c.fundingRatePerHour,
      quoteSizeUnits: c.quoteSizeUnits,
      capitalUnits: c.capitalUnits,
      running: this.isRunning(),
      state: book.serializeState(),
    };
  }

  /** Checkpoint one book (no-op when persistence is off; never throws). */
  private async persist(symbol: string): Promise<void> {
    if (!this.store.enabled) return;
    const rec = this.recordFor(symbol);
    if (!rec) return;
    const startMs = Date.now();
    try {
      await this.store.save(rec);
      this.telemetry.counter(M.persistCheckpoints, { result: 'ok' });
    } catch (e) {
      // A persistence failure threatens restart-safety — count it AND alert loudly.
      this.telemetry.counter(M.persistCheckpoints, { result: 'error' });
      this.telemetry.alert({ kind: 'persist_failure', book: symbol, severity: 'critical', message: `mm persist ${symbol}: ${(e as Error).message}` });
      this.logger.error(`mm persist ${symbol}: ${(e as Error).message}`);
    } finally {
      this.telemetry.histogram(M.persistDuration, (Date.now() - startMs) / 1000);
    }
  }

  /** Checkpoint every book (called each tick + on shutdown). */
  private async checkpointAll(): Promise<void> {
    if (!this.store.enabled) return;
    await Promise.all([...this.books.keys()].map((s) => this.persist(s)));
  }

  snapshot(): MmPortfolioSnapshot {
    const books: MmBookSnapshot[] = [];
    let cap = 0n;
    let eq = 0n;
    let real = 0n;
    let unreal = 0n;
    let fees = 0n;
    let funding = 0n;
    let net = 0n;
    for (const b of this.books.values()) {
      const s = b.snapshot();
      books.push(s);
      cap += BigInt(s.capitalUnits);
      eq += BigInt(s.equityUnits);
      real += BigInt(s.realisedPnlUnits);
      unreal += BigInt(s.unrealisedPnlUnits);
      fees += BigInt(s.feesUnits);
      funding += BigInt(s.fundingUnits);
      net += BigInt(s.netPnlUnits);
    }
    return {
      running: this.isRunning(),
      bookCount: this.books.size,
      capitalUnits: (this.books.size ? cap : this.capitalUnits).toString(),
      equityUnits: (this.books.size ? eq : this.capitalUnits).toString(),
      realisedPnlUnits: real.toString(),
      unrealisedPnlUnits: unreal.toString(),
      feesUnits: fees.toString(),
      fundingUnits: funding.toString(),
      netPnlUnits: net.toString(),
      books,
      hedge: this.hedger ? (() => { const { books: d, prices } = this.deskDeltas(); return this.hedger!.snapshot(d, prices); })() : undefined,
    };
  }
}
