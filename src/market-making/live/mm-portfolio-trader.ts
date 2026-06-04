import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { MmBook, MmBookSnapshot } from './mm-book';
import { IMmStateStore, MmBookRecord } from '../persistence/mm-state-store.interface';
import { NullMmStateStore } from '../persistence/null-mm-state-store';

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
}

export class MmPortfolioTrader implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MmPortfolioTrader.name);
  private readonly books = new Map<string, MmBook>();
  /** Per-book launch spec (source + params), kept so a book can be re-persisted. */
  private readonly specs = new Map<string, MmBookSpec>();
  private capitalUnits: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly store: IMmStateStore;
  private readonly rebuildBook?: MmBookRebuilder;
  private readonly flattenOnShutdown: boolean;

  constructor(
    private readonly makeBook: MmBookFactory,
    private readonly pollIntervalMs: number,
    initialCapitalUnits = 100_000_000_000n,
    persistence: MmPortfolioPersistence = {},
  ) {
    this.capitalUnits = initialCapitalUnits;
    this.store = persistence.store ?? new NullMmStateStore();
    this.rebuildBook = persistence.rebuildBook;
    this.flattenOnShutdown = persistence.flattenOnShutdown ?? false;
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
    this.logger.log(`launched mm book ${spec.symbol} via ${spec.strategyId ?? 'default'} (capital=${capitalUnits})`);
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
      await this.checkpointAll(); // durable P&L after every tick (no-op when persistence is off)
    } finally {
      this.ticking = false;
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
    if (rec) await this.store.save(rec).catch((e) => this.logger.error(`mm persist ${symbol}: ${(e as Error).message}`));
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
    };
  }
}
