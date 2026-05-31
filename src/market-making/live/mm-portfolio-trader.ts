import { Logger } from '@nestjs/common';
import { MmBook, MmBookSnapshot } from './mm-book';

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
}

export type MmBookFactory = (spec: MmBookSpec) => MmBook;

export interface MmPortfolioSnapshot {
  running: boolean;
  bookCount: number;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  feesUnits: string;
  netPnlUnits: string;
  books: MmBookSnapshot[];
}

export class MmPortfolioTrader {
  private readonly logger = new Logger(MmPortfolioTrader.name);
  private readonly books = new Map<string, MmBook>();
  private capitalUnits: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly makeBook: MmBookFactory,
    private readonly pollIntervalMs: number,
    initialCapitalUnits = 100_000_000_000n,
  ) {
    this.capitalUnits = initialCapitalUnits;
  }

  /**
   * Launch ONE additional MM book without disturbing the others — the human
   * "run a quoter on this instrument" action. Builds an isolated book, warms its
   * σ window, gives it its own capital, and adds it; if the loop is running it
   * starts ticking next interval. Replaces any existing book on the same symbol.
   */
  async addBook(spec: MmBookSpec, capitalUnits: bigint): Promise<void> {
    if (capitalUnits <= 0n) throw new Error('launch capital must be positive');
    const book = this.makeBook(spec);
    book.setCapital(capitalUnits);
    await book.warmup();
    book.setRunning(this.isRunning());
    this.books.set(spec.symbol, book);
    this.logger.log(`launched mm book ${spec.symbol} via ${spec.strategyId ?? 'default'} (capital=${capitalUnits})`);
  }

  /** Stop + remove one book: flatten its inventory, then drop it. */
  async removeBook(symbol: string): Promise<boolean> {
    const b = this.books.get(symbol);
    if (!b) return false;
    await b.flatten().catch(() => undefined);
    this.books.delete(symbol);
    this.logger.log(`removed mm book ${symbol}`);
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
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const b of this.books.values()) b.setRunning(false);
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
        [...this.books.values()].map((b) => b.tick().catch((e) => this.logger.error(`mm book tick error: ${(e as Error).message}`))),
      );
    } finally {
      this.ticking = false;
    }
  }

  snapshot(): MmPortfolioSnapshot {
    const books: MmBookSnapshot[] = [];
    let cap = 0n;
    let eq = 0n;
    let real = 0n;
    let unreal = 0n;
    let fees = 0n;
    let net = 0n;
    for (const b of this.books.values()) {
      const s = b.snapshot();
      books.push(s);
      cap += BigInt(s.capitalUnits);
      eq += BigInt(s.equityUnits);
      real += BigInt(s.realisedPnlUnits);
      unreal += BigInt(s.unrealisedPnlUnits);
      fees += BigInt(s.feesUnits);
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
      netPnlUnits: net.toString(),
      books,
    };
  }
}
