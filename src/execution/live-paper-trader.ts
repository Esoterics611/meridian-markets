import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Bar } from '../stat-arb/backtest/bar';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import { ITradingVenue } from '../stat-arb/trading-venue.interface';
import { BarContext, DesiredOrder } from '../stat-arb/backtest/strategy.interface';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { IRiskEngine } from '../stat-arb/risk/risk-engine';
import { GateEvent } from '../stat-arb/risk/gate';

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
}

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

export interface LiveSnapshot {
  feedId: string;
  venueId: string;
  symbolA: string;
  symbolB: string;
  running: boolean;
  barsSeen: number;
  lastBarAt: string | null;
  lastZ: number;
  beta: number;
  regime: string;
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
  private readonly historyA: Bar[] = [];
  private readonly historyB: Bar[] = [];
  private readonly maxHistory: number;

  private open: OpenPosition | null = null;
  private realisedPnlUnits = 0n;
  private readonly closed: ClosedTrade[] = [];
  private barsSeen = 0;
  private lastBarAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private peakNav = 1.0;
  private blockedEntries = 0;
  private readonly gateEvents: GateEvent[] = [];
  private readonly capitalUnits: bigint;

  constructor(
    private readonly strategy: LiveStrategy,
    private readonly venue: ITradingVenue,
    private readonly feed: IBarFeed,
    private readonly cfg: LivePaperConfig,
    private readonly repo?: StatArbRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxHistory = cfg.maxHistory ?? 500;
    this.capitalUnits = cfg.capitalUnits ?? 100_000_000n;
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

  /**
   * One loop iteration. Pulls a bar for each leg; only proceeds when BOTH legs
   * advanced (aligned bars). Safe to call directly in tests. Never throws —
   * feed/venue errors are logged and the loop continues next tick.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
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
        this.logger.warn(`OPEN blocked by risk gate at bar ${this.barsSeen - 1}`);
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
      running: this.isRunning(),
      barsSeen: this.barsSeen,
      lastBarAt: this.lastBarAt ? this.lastBarAt.toISOString() : null,
      lastZ: this.strategy.lastZ,
      beta: this.strategy.currentBeta(),
      regime: this.strategy.currentRegime(),
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
      closedTradeCount: this.closed.length,
      recentTrades: recent,
    };
  }

  private push(arr: Bar[], bar: Bar): void {
    arr.push(bar);
    if (arr.length > this.maxHistory) arr.shift();
  }
}
