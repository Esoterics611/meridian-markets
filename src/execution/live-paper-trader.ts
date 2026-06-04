import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Bar } from '../stat-arb/backtest/bar';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import { ITradingVenue } from '../stat-arb/trading-venue.interface';
import { BarContext, DesiredOrder } from '../stat-arb/backtest/strategy.interface';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { IRiskEngine } from '../stat-arb/risk/risk-engine';
import { GateEvent } from '../stat-arb/risk/gate';
import { IDeskEventSink, NULL_DESK_EVENT_SINK } from '../market-making/events/desk-event-sink';
import { statArbBlockedEvent, statArbEntryEvent, statArbExitEvent, statArbLifecycleEvent } from './live-desk-events';

// The loop depends only on this slice of a strategy, not on a concrete class.
// PairsStrategy satisfies it structurally; tests can inject a scripted fake.
export interface LiveStrategy {
  onBar(ctx: BarContext): DesiredOrder[];
  /** Last computed z-score (NaN until enough history). */
  lastZ: number;
  currentBeta(): number;
  currentRegime(): string;
  /** Restore to FLAT after the risk engine rejects an OPEN. */
  rollbackEntry?(): void;
  /** Wipe per-pair state so the instance can be reused on a different pair. */
  reset?(): void;
  /**
   * Resume in a held position on boot (restart-safe books). The strategy is
   * stateful — it only emits a CLOSE when it believes it's in-position — so a
   * rehydrated trade must put the strategy back into the held regime, else a
   * fresh strategy would re-OPEN instead of working the position off. No-op for
   * stateless strategies.
   */
  restorePosition?(side: 'LONG' | 'SHORT'): void;
}

/** Builds a fresh strategy for a chosen pair (per-pair β from discovery + chosen catalogue id + optional param overrides). */
export type StrategyFactory = (opts: { symbolA: string; symbolB: string; beta?: number; strategyId?: string; params?: Record<string, number> }) => LiveStrategy;

/**
 * Warms the rolling window from recent real bars before the first live tick.
 * Returns aligned, equal-length recent history for both legs. The live loop
 * otherwise needs ~lookback live bars (≈ an hour at 1m) before it can emit a
 * signal; seeding lets the first LIVE bar already carry full context.
 */
export type WarmupProvider = (symbolA: string, symbolB: string) => Promise<{ a: Bar[]; b: Bar[] }>;

// LivePaperTrader — the live event loop.
//
// On each tick it pulls the next CLOSED bar for both legs of a pair from a
// real market-data feed, runs the pairs strategy, and routes the resulting
// orders to a trading venue (PaperVenue in paper mode). It keeps a live book:
// open-position state, realised PnL on close, and mark-to-market on the open
// position at the latest price. Closed round-trips persist to stat_arb_trades
// when a repository is supplied.
//
// This is the same code path live trading would use — only the injected venue
// changes (PaperVenue -> a real venue). Paper results therefore predict live.

const MICROS = 1_000_000n;

export interface LivePaperConfig {
  symbolA: string;
  symbolB: string;
  /** Strategy catalogue id this book runs (StrategyRegistry). Informational on the snapshot. */
  strategyId?: string;
  /** Poll cadence in ms. Bars only advance when the feed has a new closed bar. */
  pollIntervalMs: number;
  /** Max bars retained per leg (rolling window for the strategy). */
  maxHistory?: number;
  /** Start the loop automatically on application bootstrap. */
  autoStart?: boolean;
  /** Optional pre-trade risk engine. When set, OPENs are gated (CLOSEs always pass). */
  riskEngine?: IRiskEngine;
  /** Capital anchor for the drawdown NAV ratio. Default 100 USDC. */
  capitalUnits?: bigint;
}

export interface ClosedTrade {
  side: 'LONG' | 'SHORT';
  notionalUnits: bigint;
  entryZ: number;
  exitZ: number;
  entryPriceAMicros: bigint;
  entryPriceBMicros: bigint;
  exitPriceAMicros: bigint;
  exitPriceBMicros: bigint;
  pnlUnits: bigint;
  feesUnits: bigint;
  openedAt: Date;
  closedAt: Date;
}

interface OpenPosition {
  side: 'LONG' | 'SHORT';
  notionalUnits: bigint;
  entryZ: number;
  entryPriceAMicros: bigint;
  entryPriceBMicros: bigint;
  entryFeesUnits: bigint;
  openedAt: Date;
}

/**
 * The book's durable P&L state, with bigints as decimal STRINGS so it survives
 * JSON + a Postgres BIGINT round-trip (mirrors MmBookState). The CONFIG (pair,
 * strategy, β, notional, capital) is held alongside this by the persistence
 * layer; this is just the evolving state the live loop must carry across a
 * restart. The strategy's rolling window is NOT persisted — it's re-seeded from
 * recent real bars by the warmup provider on the first tick after rehydration.
 */
export interface StatArbBookState {
  realisedPnlUnits: string;
  /** Total closed round-trips so far (the in-memory `closed` array is not persisted). */
  closedTradeCount: number;
  /** Drawdown peak (NAV ratio) — restoring it keeps the kill-switch honest across restart. */
  peakNav: number;
  barsSeen: number;
  seededBars: number;
  blockedEntries: number;
  /** The held position, or null when flat. */
  open: {
    side: 'LONG' | 'SHORT';
    notionalUnits: string;
    entryZ: number;
    entryPriceAMicros: string;
    entryPriceBMicros: string;
    entryFeesUnits: string;
    openedAt: string; // ISO
  } | null;
}

export interface LiveSnapshot {
  feedId: string;
  venueId: string;
  symbolA: string;
  symbolB: string;
  strategyId: string;
  running: boolean;
  barsSeen: number;
  /** How many of barsSeen were warmup-seeded (not live ticks). */
  seededBars: number;
  lastBarAt: string | null;
  lastZ: number;
  beta: number;
  regime: string;
  /** Starting capital anchor, 6-decimal USDC units. */
  capitalUnits: string;
  /** capital + realised + unrealised, 6-decimal USDC units. */
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  blockedEntries: number;
  gateEvents: GateEvent[];
  openPosition: {
    side: string;
    notionalUnits: string;
    entryZ: number;
    openedAt: string;
  } | null;
  closedTradeCount: number;
  recentTrades: Array<Omit<ClosedTrade, 'notionalUnits' | 'entryPriceAMicros' | 'entryPriceBMicros' | 'exitPriceAMicros' | 'exitPriceBMicros' | 'pnlUnits' | 'feesUnits' | 'openedAt' | 'closedAt'> & {
    notionalUnits: string;
    pnlUnits: string;
    feesUnits: string;
    openedAt: string;
    closedAt: string;
  }>;
}

/** Per-leg realised PnL in USDC units. Long leg profits when price rises. */
export function legPnlUnits(
  notionalUnits: bigint,
  entryMicros: bigint,
  exitMicros: bigint,
  isLong: boolean,
): bigint {
  if (entryMicros <= 0n) return 0n;
  const move = exitMicros - entryMicros; // micros
  const signed = isLong ? move : -move;
  return (notionalUnits * signed) / entryMicros;
}

export class LivePaperTrader implements OnApplicationBootstrap {
  private readonly logger = new Logger(LivePaperTrader.name);
  private strategy: LiveStrategy;
  private readonly historyA: Bar[] = [];
  private readonly historyB: Bar[] = [];
  private readonly maxHistory: number;

  private open: OpenPosition | null = null;
  private realisedPnlUnits = 0n;
  private readonly closed: ClosedTrade[] = [];
  /** Closes booked BEFORE a restart (the in-memory `closed` array starts empty on
   *  rehydration); added to `closed.length` so the snapshot count stays continuous. */
  private priorClosedCount = 0;
  private barsSeen = 0;
  private seededBars = 0;
  private warmedUp = false;
  private lastBarAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private peakNav = 1.0;
  private blockedEntries = 0;
  private readonly gateEvents: GateEvent[] = [];
  private capitalUnits: bigint;

  private readonly cfg: LivePaperConfig;

  constructor(
    strategy: LiveStrategy,
    private readonly venue: ITradingVenue,
    private readonly feed: IBarFeed,
    cfg: LivePaperConfig,
    private readonly repo?: StatArbRepository,
    private readonly now: () => Date = () => new Date(),
    /** Optional: rebuild a fresh strategy per pair (per-pair β) on reconfigure. */
    private readonly strategyFactory?: StrategyFactory,
    /** Optional: warm the rolling window from recent real bars on the first tick. */
    private readonly warmup?: WarmupProvider,
    /** Business-event tape (CLAUDE.md §8). No-op default ⇒ tests/no-DB runs unchanged. */
    private readonly events: IDeskEventSink = NULL_DESK_EVENT_SINK,
  ) {
    this.strategy = strategy;
    // Own the config: reconfigure() mutates symbolA/symbolB, so we must not
    // alias the caller's object.
    this.cfg = { ...cfg };
    this.maxHistory = cfg.maxHistory ?? 500;
    this.capitalUnits = cfg.capitalUnits ?? 100_000_000n;
  }

  /**
   * Repoint the live loop at a different pair on the SAME live feed — the
   * mechanism behind switching presaved markets while trading live data.
   * Halts the loop, wipes the book + strategy state, and (if a strategyFactory
   * was supplied) rebuilds the strategy with the new pair's β. Does NOT auto
   * restart — the caller decides when to re-arm.
   */
  reconfigure(opts: { symbolA: string; symbolB: string; beta?: number; strategyId?: string; params?: Record<string, number> }): void {
    this.stop();
    this.cfg.symbolA = opts.symbolA;
    this.cfg.symbolB = opts.symbolB;
    if (opts.strategyId) this.cfg.strategyId = opts.strategyId;
    if (this.strategyFactory) {
      this.strategy = this.strategyFactory({ ...opts, strategyId: this.cfg.strategyId });
    } else {
      this.strategy.reset?.();
    }
    this.historyA.length = 0;
    this.historyB.length = 0;
    this.open = null;
    this.closed.length = 0;
    this.priorClosedCount = 0;
    this.realisedPnlUnits = 0n;
    this.barsSeen = 0;
    this.seededBars = 0;
    this.warmedUp = false;
    this.lastBarAt = null;
    this.peakNav = 1.0;
    this.blockedEntries = 0;
    this.gateEvents.length = 0;
    this.logger.log(`reconfigured to ${opts.symbolA}/${opts.symbolB} via ${this.cfg.strategyId ?? 'default'} (β=${opts.beta ?? 'cfg'})`);
    this.events.emit(
      statArbLifecycleEvent({
        ts: this.now().getTime(),
        kind: 'launch',
        book: this.pairLabel(),
        source: this.feed.feedId,
        message: `${this.pairLabel()} ▸ reconfigured via ${this.cfg.strategyId ?? 'default'} (β=${opts.beta ?? 'cfg'})`,
      }),
    );
  }

  /**
   * Pre-fill the rolling window from recent real bars so the strategy has
   * context immediately. Trades are NEVER evaluated on seeded bars — they only
   * supply the window the next LIVE bar's signal is computed against. Caller
   * passes aligned, equal-length series (same timestamps per index).
   */
  seedHistory(a: Bar[], b: Bar[]): void {
    if (this.historyA.length > 0) return; // only seed an empty book
    const n = Math.min(a.length, b.length);
    if (n === 0) return;
    const start = Math.max(0, n - this.maxHistory);
    for (let i = start; i < n; i++) {
      this.historyA.push(a[i]);
      this.historyB.push(b[i]);
    }
    this.seededBars = this.historyA.length;
    this.barsSeen += this.seededBars;
    this.lastBarAt = a[n - 1].timestamp;
    this.logger.log(`seeded ${this.seededBars} warmup bars for ${this.cfg.symbolA}/${this.cfg.symbolB}`);
  }

  /**
   * Set the starting capital anchor (drives NAV/equity + the drawdown gate).
   * Resets realised PnL and the drawdown peak so the equity curve restarts from
   * the new capital — this is "set the starting balance", not an injection of
   * funds mid-run. Rejects non-positive input.
   */
  setStartingCapital(units: bigint): void {
    if (units <= 0n) throw new Error('starting capital must be positive');
    this.capitalUnits = units;
    this.realisedPnlUnits = 0n;
    this.closed.length = 0;
    this.priorClosedCount = 0;
    this.peakNav = 1.0;
    this.logger.log(`starting capital set to ${units} units`);
  }

  capital(): bigint {
    return this.capitalUnits;
  }

  onApplicationBootstrap(): void {
    if (this.cfg.autoStart) {
      this.logger.log('LIVE_AUTOSTART=true — starting paper loop on boot');
      this.start();
    }
  }

  start(): void {
    if (this.timer) return;
    this.logger.log(
      `LivePaperTrader start: ${this.cfg.symbolA}/${this.cfg.symbolB} via ${this.feed.feedId} -> ${this.venue.venueId}`,
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.pollIntervalMs);
    this.events.emit(
      statArbLifecycleEvent({
        ts: this.now().getTime(),
        kind: 'start',
        book: this.pairLabel(),
        source: this.feed.feedId,
        message: `${this.pairLabel()} ▸ live loop started (${this.feed.feedId} → ${this.venue.venueId})`,
      }),
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.events.emit(
        statArbLifecycleEvent({ ts: this.now().getTime(), kind: 'stop', book: this.pairLabel(), source: this.feed.feedId, message: `${this.pairLabel()} ▸ live loop stopped` }),
      );
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Force-close the open position now (manual flatten): book the round-trip via
   * the venue at the latest fills, then stop the loop so the strategy's stale
   * in-position state can't immediately re-fire. Re-arming rebuilds a fresh
   * strategy. No-op when already flat. Returns whether a position was closed.
   */
  async flatten(): Promise<boolean> {
    if (!this.open) return false;
    const aLong = this.open.side === 'LONG';
    await this.closePosition([
      { symbol: this.cfg.symbolA, side: aLong ? 'SELL' : 'BUY', notionalUnits: this.open.notionalUnits, reason: 'CLOSE' },
      { symbol: this.cfg.symbolB, side: aLong ? 'BUY' : 'SELL', notionalUnits: this.open.notionalUnits, reason: 'CLOSE' },
    ]);
    this.stop();
    return true;
  }

  /**
   * One loop iteration. Pulls a bar for each leg; only proceeds when BOTH legs
   * advanced (aligned bars). Safe to call directly in tests. Never throws —
   * feed/venue errors are logged and the loop continues next tick.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.warmedUp && this.warmup) {
        try {
          const seed = await this.warmup(this.cfg.symbolA, this.cfg.symbolB);
          this.seedHistory(seed.a, seed.b);
        } catch (err) {
          this.logger.warn(`warmup failed: ${(err as Error).message}`);
        } finally {
          this.warmedUp = true;
        }
      }
      const [barA, barB] = await Promise.all([
        this.feed.nextBar(this.cfg.symbolA),
        this.feed.nextBar(this.cfg.symbolB),
      ]);
      if (!barA || !barB) return; // no new aligned bar yet
      await this.onAlignedBars(barA, barB);
    } catch (err) {
      this.logger.error(`tick error: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async onAlignedBars(barA: Bar, barB: Bar): Promise<void> {
    this.push(this.historyA, barA);
    this.push(this.historyB, barB);
    this.barsSeen += 1;
    this.lastBarAt = barA.timestamp;

    const orders = this.strategy.onBar({
      a: barA,
      b: barB,
      // In-array index, not the absolute bar count: the strategy slices into
      // historyA/B by this value, and the rolling window may have been trimmed.
      index: this.historyA.length - 1,
      historyA: this.historyA,
      historyB: this.historyB,
    });
    if (orders.length === 0) return;

    const reason = orders[0].reason;
    if (reason === 'OPEN_LONG' || reason === 'OPEN_SHORT') {
      await this.openPosition(orders, reason === 'OPEN_LONG' ? 'LONG' : 'SHORT');
    } else {
      await this.closePosition(orders);
    }
  }

  private async openPosition(orders: DesiredOrder[], side: 'LONG' | 'SHORT'): Promise<void> {
    // Pre-trade risk gate on OPENs (drawdown). CLOSEs always pass.
    if (this.cfg.riskEngine) {
      const navRatio = Number(this.capitalUnits + this.realisedPnlUnits) / Number(this.capitalUnits);
      this.peakNav = Math.max(this.peakNav, navRatio);
      const decisions = this.cfg.riskEngine.preTradeCheck({
        barIndex: this.barsSeen - 1,
        drawdown: { navRatio, peakNav: this.peakNav },
      });
      if (!decisions.every((d) => d.allow)) {
        this.blockedEntries += 1;
        this.gateEvents.push(...this.cfg.riskEngine.drainEvents());
        this.strategy.rollbackEntry?.(); // re-attempt on a later bar
        this.events.emit(
          statArbBlockedEvent({ ts: this.now().getTime(), pair: this.pairLabel(), source: this.feed.feedId, side, barIndex: this.barsSeen - 1 }),
        );
        return;
      }
    }
    const fills = await this.place(orders);
    const a = fills[this.cfg.symbolA];
    const b = fills[this.cfg.symbolB];
    if (!a || !b) return;
    this.open = {
      side,
      notionalUnits: orders[0].notionalUnits,
      entryZ: this.strategy.lastZ,
      entryPriceAMicros: a.priceMicros,
      entryPriceBMicros: b.priceMicros,
      entryFeesUnits: a.feesUnits + b.feesUnits,
      openedAt: this.now(),
    };
    this.events.emit(
      statArbEntryEvent({
        ts: this.open.openedAt.getTime(),
        pair: this.pairLabel(),
        source: this.feed.feedId,
        side,
        notionalUnits: this.open.notionalUnits,
        entryZ: this.open.entryZ,
        feeUnits: this.open.entryFeesUnits,
        symbolA: this.cfg.symbolA,
        symbolB: this.cfg.symbolB,
      }),
    );
  }

  private async closePosition(orders: DesiredOrder[]): Promise<void> {
    const pos = this.open;
    if (!pos) return;
    const fills = await this.place(orders);
    const a = fills[this.cfg.symbolA];
    const b = fills[this.cfg.symbolB];
    if (!a || !b) return;

    // Leg directions at ENTRY: LONG spread = long A / short B; SHORT = reverse.
    const aLong = pos.side === 'LONG';
    const pnlA = legPnlUnits(pos.notionalUnits, pos.entryPriceAMicros, a.priceMicros, aLong);
    const pnlB = legPnlUnits(pos.notionalUnits, pos.entryPriceBMicros, b.priceMicros, !aLong);
    const feesUnits = pos.entryFeesUnits + a.feesUnits + b.feesUnits;
    const pnlUnits = pnlA + pnlB - feesUnits;

    const trade: ClosedTrade = {
      side: pos.side,
      notionalUnits: pos.notionalUnits,
      entryZ: pos.entryZ,
      exitZ: this.strategy.lastZ,
      entryPriceAMicros: pos.entryPriceAMicros,
      entryPriceBMicros: pos.entryPriceBMicros,
      exitPriceAMicros: a.priceMicros,
      exitPriceBMicros: b.priceMicros,
      pnlUnits,
      feesUnits,
      openedAt: pos.openedAt,
      closedAt: this.now(),
    };
    this.closed.push(trade);
    this.realisedPnlUnits += pnlUnits;
    this.open = null;
    this.events.emit(
      statArbExitEvent({
        ts: trade.closedAt.getTime(),
        pair: this.pairLabel(),
        source: this.feed.feedId,
        side: trade.side,
        notionalUnits: trade.notionalUnits,
        exitZ: trade.exitZ,
        realisedDeltaUnits: trade.pnlUnits,
        feeUnits: trade.feesUnits,
      }),
    );

    if (this.repo) {
      try {
        await this.repo.insertTrade({
          venue: this.venue.venueId,
          symbolA: this.cfg.symbolA,
          symbolB: this.cfg.symbolB,
          side: trade.side,
          entryZ: trade.entryZ,
          exitZ: trade.exitZ,
          entryPriceAMicros: trade.entryPriceAMicros,
          entryPriceBMicros: trade.entryPriceBMicros,
          exitPriceAMicros: trade.exitPriceAMicros,
          exitPriceBMicros: trade.exitPriceBMicros,
          notionalUnits: trade.notionalUnits,
          pnlUnits: trade.pnlUnits,
          feesUnits: trade.feesUnits,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt,
          idempotencyKey: `${this.venue.venueId}:${trade.openedAt.getTime()}:${trade.closedAt.getTime()}`,
        });
      } catch (err) {
        this.logger.error(`persist trade failed: ${(err as Error).message}`);
      }
    }
  }

  private async place(orders: DesiredOrder[]): Promise<Record<string, { priceMicros: bigint; feesUnits: bigint }>> {
    const out: Record<string, { priceMicros: bigint; feesUnits: bigint }> = {};
    for (const o of orders) {
      const fill = await this.venue.placeOrder({
        symbol: o.symbol,
        side: o.side,
        notionalUnits: o.notionalUnits,
        idempotencyKey: `${this.venue.venueId}:${o.symbol}:${o.reason}:${this.barsSeen}:${this.now().getTime()}`,
      });
      out[o.symbol] = { priceMicros: fill.priceMicros, feesUnits: fill.feesUnits };
    }
    return out;
  }

  /** Unrealised PnL of the open position at the latest bar closes. */
  unrealisedPnlUnits(): bigint {
    const pos = this.open;
    if (!pos) return 0n;
    const lastA = this.historyA[this.historyA.length - 1];
    const lastB = this.historyB[this.historyB.length - 1];
    if (!lastA || !lastB) return 0n;
    const markA = BigInt(Math.round(lastA.close * 1_000_000));
    const markB = BigInt(Math.round(lastB.close * 1_000_000));
    const aLong = pos.side === 'LONG';
    return (
      legPnlUnits(pos.notionalUnits, pos.entryPriceAMicros, markA, aLong) +
      legPnlUnits(pos.notionalUnits, pos.entryPriceBMicros, markB, !aLong)
    );
  }

  closedTrades(): ClosedTrade[] {
    return this.closed.slice();
  }

  snapshot(): LiveSnapshot {
    const recent = this.closed.slice(-20).map((t) => ({
      side: t.side,
      entryZ: t.entryZ,
      exitZ: t.exitZ,
      notionalUnits: t.notionalUnits.toString(),
      pnlUnits: t.pnlUnits.toString(),
      feesUnits: t.feesUnits.toString(),
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt.toISOString(),
    }));
    return {
      feedId: this.feed.feedId,
      venueId: this.venue.venueId,
      symbolA: this.cfg.symbolA,
      symbolB: this.cfg.symbolB,
      strategyId: this.cfg.strategyId ?? 'pairs-zscore',
      running: this.isRunning(),
      barsSeen: this.barsSeen,
      seededBars: this.seededBars,
      lastBarAt: this.lastBarAt ? this.lastBarAt.toISOString() : null,
      lastZ: this.strategy.lastZ,
      beta: this.strategy.currentBeta(),
      regime: this.strategy.currentRegime(),
      capitalUnits: this.capitalUnits.toString(),
      equityUnits: (this.capitalUnits + this.realisedPnlUnits + this.unrealisedPnlUnits()).toString(),
      realisedPnlUnits: this.realisedPnlUnits.toString(),
      unrealisedPnlUnits: this.unrealisedPnlUnits().toString(),
      blockedEntries: this.blockedEntries,
      gateEvents: this.gateEvents.slice(-20),
      openPosition: this.open
        ? {
            side: this.open.side,
            notionalUnits: this.open.notionalUnits.toString(),
            entryZ: this.open.entryZ,
            openedAt: this.open.openedAt.toISOString(),
          }
        : null,
      closedTradeCount: this.closed.length + this.priorClosedCount,
      recentTrades: recent,
    };
  }

  /**
   * Serialise the evolving P&L state for a durable checkpoint (restart-safe
   * books). The config + strategy are rebuilt from the persisted record on boot;
   * this carries only the state the live loop can't re-derive. Bigints → strings.
   */
  serializeState(): StatArbBookState {
    return {
      realisedPnlUnits: this.realisedPnlUnits.toString(),
      closedTradeCount: this.closed.length + this.priorClosedCount,
      peakNav: this.peakNav,
      barsSeen: this.barsSeen,
      seededBars: this.seededBars,
      blockedEntries: this.blockedEntries,
      open: this.open
        ? {
            side: this.open.side,
            notionalUnits: this.open.notionalUnits.toString(),
            entryZ: this.open.entryZ,
            entryPriceAMicros: this.open.entryPriceAMicros.toString(),
            entryPriceBMicros: this.open.entryPriceBMicros.toString(),
            entryFeesUnits: this.open.entryFeesUnits.toString(),
            openedAt: this.open.openedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Restore a checkpointed state onto a freshly-built book (boot rehydration).
   * Call AFTER setStartingCapital (which zeroes the curve). If a position was
   * held, the strategy is put back into that regime so it works the position off
   * on the next tick instead of re-opening. The rolling window is re-seeded by
   * the warmup provider, not restored here.
   */
  restoreState(s: StatArbBookState): void {
    this.realisedPnlUnits = BigInt(s.realisedPnlUnits);
    this.priorClosedCount = s.closedTradeCount;
    this.closed.length = 0;
    this.peakNav = s.peakNav;
    this.barsSeen = s.barsSeen;
    this.seededBars = s.seededBars;
    this.blockedEntries = s.blockedEntries;
    this.open = s.open
      ? {
          side: s.open.side,
          notionalUnits: BigInt(s.open.notionalUnits),
          entryZ: s.open.entryZ,
          entryPriceAMicros: BigInt(s.open.entryPriceAMicros),
          entryPriceBMicros: BigInt(s.open.entryPriceBMicros),
          entryFeesUnits: BigInt(s.open.entryFeesUnits),
          openedAt: new Date(s.open.openedAt),
        }
      : null;
    if (this.open) this.strategy.restorePosition?.(this.open.side);
  }

  private pairLabel(): string {
    return `${this.cfg.symbolA}/${this.cfg.symbolB}`;
  }

  private push(arr: Bar[], bar: Bar): void {
    arr.push(bar);
    if (arr.length > this.maxHistory) arr.shift();
  }
}
