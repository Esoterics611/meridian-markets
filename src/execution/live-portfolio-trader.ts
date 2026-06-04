import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { LivePaperTrader } from './live-paper-trader';
import { IDeskEventSink, NULL_DESK_EVENT_SINK } from '../market-making/events/desk-event-sink';
import { statArbLifecycleEvent } from './live-desk-events';
import { IStatArbStateStore, StatArbBookRecord } from '../stat-arb/persistence/stat-arb-state-store.interface';
import { NullStatArbStateStore } from '../stat-arb/persistence/null-stat-arb-state-store';

// LivePortfolioTrader — the multi-currency generalisation of LivePaperTrader.
//
// Runs N pairs concurrently on the live feed, each as an isolated paper book
// (its own feed cursor + venue + strategy, built by `makeTrader`), so pairs that
// share a symbol (e.g. ETH/BTC and SOL/BTC both touch BTC) never fight over a
// shared bar cursor. Capital is split evenly across the active pairs. One timer
// ticks every book; the snapshot aggregates portfolio-level equity/PnL and a
// per-pair breakdown.
//
// This is the "Session 10" multi-strategy/multi-currency desk in its simplest
// honest form: many books, one capital pool, one control plane. A budget
// allocator (mean-variance sizing instead of even split) is the next refinement.

export interface PortfolioPair {
  symbolA: string;
  symbolB: string;
  beta?: number;
  /** Strategy catalogue id this book runs. Defaults to the live config default. */
  strategyId?: string;
  /** Per-launch overrides of the strategy's frozen params (from the launch form). */
  params?: Record<string, number>;
  /** Data source for this book's feed/prices ('binance' default, or 'pyth', …). */
  source?: string;
  /** Per-leg trade notional in 6-dec USDC units (the "lot size"). Defaults to
   *  the live config notional when omitted — set it to size trades from the UI. */
  notionalUnits?: bigint;
}

export interface PortfolioBookRow {
  pair: string;
  symbolA: string;
  symbolB: string;
  strategyId: string;
  beta: number;
  /** This book's data feed id (e.g. 'binance.spot', 'ref.pyth'). */
  feedId: string;
  lastZ: number;
  regime: string;
  running: boolean;
  barsSeen: number;
  /** ISO time of the last aligned bar this book processed (staleness check). */
  lastBarAt: string | null;
  /** How many of barsSeen were warmup-seeded (not live ticks). */
  seededBars: number;
  /** OPENs blocked by this book's risk gate so far. */
  blockedEntries: number;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  position: string | null;
}

export interface PortfolioSnapshot {
  running: boolean;
  feedId: string;
  venueId: string;
  pairCount: number;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  books: PortfolioBookRow[];
}

export type TraderFactory = (pair: PortfolioPair) => LivePaperTrader;

const pairKey = (p: PortfolioPair) => `${p.symbolA}/${p.symbolB}`;

export interface StatArbPortfolioPersistence {
  /** Durable checkpoint store. NullStatArbStateStore (default) ⇒ in-memory only. */
  store?: IStatArbStateStore;
  /** Flatten every book before the final checkpoint on shutdown. */
  flattenOnShutdown?: boolean;
  /** Resolved per-leg notional used when a launched pair omits its own (the row is NOT NULL). */
  defaultNotionalUnits?: bigint;
}

export class LivePortfolioTrader implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LivePortfolioTrader.name);
  private readonly books = new Map<string, LivePaperTrader>();
  /** Per-book launch config (pair + β + strategy + notional), kept so a book can be re-persisted. */
  private readonly specs = new Map<string, PortfolioPair>();
  private capitalUnits: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly store: IStatArbStateStore;
  private readonly flattenOnShutdown: boolean;
  private readonly defaultNotionalUnits: bigint;

  constructor(
    private readonly makeTrader: TraderFactory,
    private readonly pollIntervalMs: number,
    initialCapitalUnits = 100_000_000n,
    /** Business-event tape (CLAUDE.md §8). No-op default ⇒ tests/no-DB runs unchanged. */
    private readonly events: IDeskEventSink = NULL_DESK_EVENT_SINK,
    /** Restart-safe books (CLAUDE.md §7). Null store default ⇒ in-memory only, tests unchanged. */
    persistence: StatArbPortfolioPersistence = {},
  ) {
    this.capitalUnits = initialCapitalUnits;
    this.store = persistence.store ?? new NullStatArbStateStore();
    this.flattenOnShutdown = persistence.flattenOnShutdown ?? false;
    this.defaultNotionalUnits = persistence.defaultNotionalUnits ?? initialCapitalUnits;
  }

  /** Boot: rehydrate persisted OPEN books (restart-safe). Stopped until start(). */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.store.enabled) return;
    const records = await this.store.loadOpen().catch((e) => {
      this.logger.error(`stat-arb rehydrate load failed: ${(e as Error).message}`);
      return [] as StatArbBookRecord[];
    });
    for (const rec of records) {
      try {
        const pair = pairFromRecord(rec);
        const trader = this.makeTrader(pair);
        trader.setStartingCapital(rec.capitalUnits);
        trader.restoreState(rec.state); // carry forward realised P&L + the held position
        this.books.set(rec.bookKey, trader);
        this.specs.set(rec.bookKey, pair);
      } catch (e) {
        this.logger.error(`stat-arb rehydrate ${rec.bookKey} failed: ${(e as Error).message}`);
      }
    }
    if (this.books.size) this.logger.log(`rehydrated ${this.books.size} stat-arb book(s) from persistence — start the desk to resume`);
  }

  /** Shutdown: optionally flatten, then checkpoint final state (a real company's books). */
  async onApplicationShutdown(): Promise<void> {
    this.stop();
    if (this.flattenOnShutdown) await this.flattenAll();
    await this.checkpointAll();
  }

  private emitLifecycle(kind: 'launch' | 'remove' | 'start' | 'stop', book: string, message: string): void {
    this.events.emit(statArbLifecycleEvent({ ts: Date.now(), kind, book, message }));
  }

  /**
   * Replace the active pair set. Halts the loop, rebuilds one isolated book per
   * pair, and splits `totalCapitalUnits` (or the current capital) evenly across
   * them. Does not auto-start.
   */
  setPairs(pairs: PortfolioPair[], totalCapitalUnits?: bigint): void {
    this.stop();
    if (totalCapitalUnits !== undefined) {
      if (totalCapitalUnits <= 0n) throw new Error('portfolio capital must be positive');
      this.capitalUnits = totalCapitalUnits;
    }
    this.books.clear();
    this.specs.clear();
    const unique = dedupe(pairs);
    if (unique.length === 0) return;
    const perBook = this.capitalUnits / BigInt(unique.length);
    for (const p of unique) {
      const trader = this.makeTrader(p);
      trader.setStartingCapital(perBook > 0n ? perBook : 1n);
      this.books.set(pairKey(p), trader);
      this.specs.set(pairKey(p), p);
    }
    this.logger.log(`portfolio set to ${unique.length} pairs: ${unique.map(pairKey).join(', ')}`);
    for (const p of unique) this.emitLifecycle('launch', pairKey(p), `${pairKey(p)} ▸ launched via ${p.strategyId ?? 'default'}`);
    void this.checkpointAll(); // durable from the moment the set is defined
  }

  /**
   * Launch a single additional book without disturbing the others — the human
   * "launch a station" action. Builds an isolated trader for `pair`, gives it
   * its own starting capital, and adds it to the live set; if the loop is
   * already running it begins ticking on the next interval. Replaces any
   * existing book on the same pair (re-launch with new params).
   */
  addBook(pair: PortfolioPair, capitalUnits: bigint): void {
    if (pair.symbolA === pair.symbolB) throw new Error('cannot launch a book on identical legs');
    if (capitalUnits <= 0n) throw new Error('launch capital must be positive');
    const key = pairKey(pair);
    const trader = this.makeTrader(pair);
    trader.setStartingCapital(capitalUnits);
    this.books.set(key, trader);
    this.specs.set(key, pair);
    this.logger.log(`launched book ${key} via ${pair.strategyId ?? 'default'} (capital=${capitalUnits})`);
    this.emitLifecycle('launch', key, `${key} ▸ launched via ${pair.strategyId ?? 'default'} (capital ${capitalUnits} units)`);
    void this.persist(key); // durable from launch
  }

  /** Flatten every book's open position (manual desk-wide flatten). */
  async flattenAll(): Promise<void> {
    await Promise.all([...this.books.values()].map((b) => b.flatten().catch(() => undefined)));
  }

  /**
   * Stop and remove a single station: flatten its open position, then drop it
   * from the live set. Stops the loop when the last book is removed. Returns
   * whether a book was removed.
   */
  async removeBook(pair: string): Promise<boolean> {
    const t = this.books.get(pair);
    if (!t) return false;
    await t.flatten().catch(() => undefined);
    await this.persist(pair); // checkpoint the flattened state before soft-closing
    this.books.delete(pair);
    this.specs.delete(pair);
    if (this.store.enabled) await this.store.close(pair).catch((e) => this.logger.error(`stat-arb close ${pair}: ${(e as Error).message}`));
    this.logger.log(`removed book ${pair}`);
    this.emitLifecycle('remove', pair, `${pair} ▸ removed (flattened + dropped)`);
    if (this.books.size === 0) this.stop();
    return true;
  }

  start(): void {
    if (this.timer || this.books.size === 0) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.emitLifecycle('start', '', `stat-arb desk ▸ loop started (${this.books.size} book${this.books.size === 1 ? '' : 's'})`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emitLifecycle('stop', '', 'stat-arb desk ▸ loop stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** One iteration: tick every book. Never throws — a single book's error is logged. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(
        [...this.books.values()].map((b) =>
          b.tick().catch((e) => this.logger.error(`book tick error: ${(e as Error).message}`)),
        ),
      );
      await this.checkpointAll(); // durable P&L after every tick (no-op when persistence is off)
    } finally {
      this.ticking = false;
    }
  }

  /** Build a durable record for one book (config from its spec + serialized P&L state). */
  private recordFor(bookKey: string): StatArbBookRecord | null {
    const trader = this.books.get(bookKey);
    const spec = this.specs.get(bookKey);
    if (!trader || !spec) return null;
    return {
      bookKey,
      symbolA: spec.symbolA,
      symbolB: spec.symbolB,
      source: spec.source ?? null,
      strategyId: spec.strategyId ?? 'pairs-zscore',
      beta: spec.beta ?? null,
      params: spec.params ?? null,
      notionalUnits: spec.notionalUnits ?? this.defaultNotionalUnits,
      capitalUnits: trader.capital(),
      running: this.isRunning(),
      state: trader.serializeState(),
    };
  }

  /** Checkpoint one book (no-op when persistence is off; never throws). */
  private async persist(bookKey: string): Promise<void> {
    if (!this.store.enabled) return;
    const rec = this.recordFor(bookKey);
    if (!rec) return;
    try {
      await this.store.save(rec);
    } catch (e) {
      this.logger.error(`stat-arb persist ${bookKey}: ${(e as Error).message}`);
    }
  }

  /** Checkpoint every book (called each tick + on shutdown). */
  private async checkpointAll(): Promise<void> {
    if (!this.store.enabled) return;
    await Promise.all([...this.books.keys()].map((k) => this.persist(k)));
  }

  setCapital(totalUnits: bigint): void {
    if (totalUnits <= 0n) throw new Error('portfolio capital must be positive');
    this.capitalUnits = totalUnits;
    // Re-split across the existing books, restarting each book's equity curve.
    const n = this.books.size;
    if (n > 0) {
      const perBook = totalUnits / BigInt(n);
      for (const b of this.books.values()) b.setStartingCapital(perBook > 0n ? perBook : 1n);
    }
  }

  snapshot(): PortfolioSnapshot {
    const books: PortfolioBookRow[] = [];
    let cap = 0n, eq = 0n, real = 0n, unreal = 0n;
    let feedId = '—', venueId = '—';
    for (const t of this.books.values()) {
      const s = t.snapshot();
      feedId = s.feedId;
      venueId = s.venueId;
      cap += BigInt(s.capitalUnits);
      eq += BigInt(s.equityUnits);
      real += BigInt(s.realisedPnlUnits);
      unreal += BigInt(s.unrealisedPnlUnits);
      books.push({
        pair: `${s.symbolA}/${s.symbolB}`,
        symbolA: s.symbolA,
        symbolB: s.symbolB,
        strategyId: s.strategyId,
        beta: s.beta,
        feedId: s.feedId,
        lastZ: s.lastZ,
        regime: s.regime,
        running: this.isRunning(),
        barsSeen: s.barsSeen,
        lastBarAt: s.lastBarAt,
        seededBars: s.seededBars,
        blockedEntries: s.blockedEntries,
        capitalUnits: s.capitalUnits,
        equityUnits: s.equityUnits,
        realisedPnlUnits: s.realisedPnlUnits,
        unrealisedPnlUnits: s.unrealisedPnlUnits,
        position: s.openPosition ? s.openPosition.side : null,
      });
    }
    return {
      running: this.isRunning(),
      feedId,
      venueId,
      pairCount: this.books.size,
      capitalUnits: (this.books.size ? cap : this.capitalUnits).toString(),
      equityUnits: (this.books.size ? eq : this.capitalUnits).toString(),
      realisedPnlUnits: real.toString(),
      unrealisedPnlUnits: unreal.toString(),
      books,
    };
  }
}

/** Reconstruct the launch PortfolioPair from a persisted record (boot rehydration). */
function pairFromRecord(rec: StatArbBookRecord): PortfolioPair {
  return {
    symbolA: rec.symbolA,
    symbolB: rec.symbolB,
    beta: rec.beta ?? undefined,
    strategyId: rec.strategyId,
    params: rec.params ?? undefined,
    source: rec.source ?? undefined,
    notionalUnits: rec.notionalUnits,
  };
}

/** Keep the first occurrence of each symbolA/symbolB key. */
function dedupe(pairs: PortfolioPair[]): PortfolioPair[] {
  const seen = new Set<string>();
  const out: PortfolioPair[] = [];
  for (const p of pairs) {
    const k = pairKey(p);
    if (!seen.has(k) && p.symbolA !== p.symbolB) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}
