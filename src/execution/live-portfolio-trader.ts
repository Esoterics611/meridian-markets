import { Logger } from '@nestjs/common';
import { LivePaperTrader } from './live-paper-trader';

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
}

export interface PortfolioBookRow {
  pair: string;
  symbolA: string;
  symbolB: string;
  strategyId: string;
  beta: number;
  lastZ: number;
  regime: string;
  running: boolean;
  barsSeen: number;
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

export class LivePortfolioTrader {
  private readonly logger = new Logger(LivePortfolioTrader.name);
  private readonly books = new Map<string, LivePaperTrader>();
  private capitalUnits: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly makeTrader: TraderFactory,
    private readonly pollIntervalMs: number,
    initialCapitalUnits = 100_000_000n,
  ) {
    this.capitalUnits = initialCapitalUnits;
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
    const unique = dedupe(pairs);
    if (unique.length === 0) return;
    const perBook = this.capitalUnits / BigInt(unique.length);
    for (const p of unique) {
      const trader = this.makeTrader(p);
      trader.setStartingCapital(perBook > 0n ? perBook : 1n);
      this.books.set(pairKey(p), trader);
    }
    this.logger.log(`portfolio set to ${unique.length} pairs: ${unique.map(pairKey).join(', ')}`);
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
    this.logger.log(`launched book ${key} via ${pair.strategyId ?? 'default'} (capital=${capitalUnits})`);
  }

  start(): void {
    if (this.timer || this.books.size === 0) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
    } finally {
      this.ticking = false;
    }
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
        lastZ: s.lastZ,
        regime: s.regime,
        running: this.isRunning(),
        barsSeen: s.barsSeen,
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
