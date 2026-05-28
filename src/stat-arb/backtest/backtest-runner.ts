import { Bar } from './bar';
import { BarContext, DesiredOrder, IStrategy } from './strategy.interface';
import { ITradingVenue, Side } from '../trading-venue.interface';
import { summarize, BacktestMetrics } from './pnl-attribution';
import { PairsStrategy, Regime } from './pairs-strategy';
import { IRiskEngine } from '../risk/risk-engine';
import { GateEvent as RiskGateEvent } from '../risk/gate';
import { StatArbRepository } from '../persistence/stat-arb.repository';

// Event-driven backtest runner. Walks bars in chronological order, invokes
// the strategy with strictly historical context, places orders through the
// injected ITradingVenue (the mock for the demo), and tracks per-trade P&L.
//
// Invariant: the strategy never sees a bar beyond ctx.index. Tested in
// backtest.spec.ts by running two strategies on the same feed and asserting
// identical orders.

export interface TradeRecord {
  /** Opened at this bar index. */
  openIndex: number;
  /** Closed at this bar index (inclusive). */
  closeIndex: number;
  side: 'LONG' | 'SHORT'; // direction of the SPREAD position
  entryZ: number;
  exitZ: number;
  pnlUnits: bigint;
  holdBars: number;
}

export interface BacktestResult {
  trades: TradeRecord[];
  metrics: BacktestMetrics;
  spreadSeries: { timestamp: Date; zScore: number; position: Regime }[];
  /** Risk-engine gate events emitted across the run. Empty when no engine is supplied. */
  gateEvents: RiskGateEvent[];
  /** Count of OPEN orders blocked by the risk engine. */
  blockedEntries: number;
}

export interface BacktestConfig {
  barsA: Bar[];
  barsB: Bar[];
  strategy: PairsStrategy;
  venue: ITradingVenue;
  /** Optional risk engine. When provided, OPEN orders are pre-trade-checked. */
  riskEngine?: IRiskEngine;
  /** Used to build risk context. Defaults: notionalUnits per leg, single-venue mock. */
  riskOpts?: {
    capitalUnits: bigint;
    pairId: string;
    /** Used as the per-bar drawdown peak/nav anchor. */
    initialNavRatio?: number;
  };
  /** Optional persistence: when supplied, each closed trade is written to stat_arb_trades. */
  repository?: StatArbRepository;
  /** Distinguishes runs in the idempotency key namespace (e.g. `${scenario}-${Date.now()}`). */
  runId?: string;
}

/** Stateless coordinator: feed → strategy → venue → metrics. */
export class BacktestRunner {
  async run(cfg: BacktestConfig): Promise<BacktestResult> {
    if (cfg.barsA.length !== cfg.barsB.length) {
      throw new Error('BacktestRunner.run: barsA and barsB must have same length');
    }
    const trades: TradeRecord[] = [];
    const spreadSeries: BacktestResult['spreadSeries'] = [];
    let blockedEntries = 0;

    // Track running NAV (against capital) and peak — fed into the drawdown gate.
    const capital = cfg.riskOpts?.capitalUnits ?? 100_000_000n; // 100 USDC default
    let pnlSoFar = 0n;
    let peakNav = cfg.riskOpts?.initialNavRatio ?? 1.0;
    // Live notional per venue across the book — fed into the venue cap gate.
    let venueLiveNotional = 0n;
    // Open per-pair exposure tracked at leg granularity for the exposure gate.
    let openLongUnits = 0n;
    let openShortUnits = 0n;

    // We track each round-trip's opening leg fills so we can attribute P&L
    // when the close fills arrive. For a pairs trade there's a long+short
    // leg pair on each side; we store them keyed by entry index.
    interface OpenState {
      openIndex: number;
      side: 'LONG' | 'SHORT';
      entryZ: number;
      // Per-symbol open price in micros (positive notional convention).
      openPriceA: bigint;
      openPriceB: bigint;
      // Fees paid on the opening fills.
      openFeesUnits: bigint;
      notionalUnits: bigint;
    }
    let open: OpenState | null = null;

    for (let i = 0; i < cfg.barsA.length; i++) {
      const a = cfg.barsA[i];
      const b = cfg.barsB[i];
      const ctx: BarContext = {
        a,
        b,
        index: i,
        historyA: cfg.barsA.slice(0, i + 1),
        historyB: cfg.barsB.slice(0, i + 1),
      };
      const orders = cfg.strategy.onBar(ctx);

      // Snapshot the regime BEFORE processing fills so the spreadSeries
      // entry reflects what the strategy decided at this bar.
      const zNow = cfg.strategy.lastZ;
      spreadSeries.push({
        timestamp: a.timestamp,
        zScore: Number.isFinite(zNow) ? zNow : 0,
        position: cfg.strategy.currentRegime(),
      });

      if (orders.length === 0) continue;

      // Risk-engine pre-trade check on OPEN orders only. CLOSE orders always go
      // through — same posture as the p-value gate in pairs-strategy.ts.
      const isOpen = orders[0].reason !== 'CLOSE';
      if (cfg.riskEngine && isOpen) {
        const notionalLeg = orders[0].notionalUnits;
        const navRatio = Number(capital + pnlSoFar) / Number(capital);
        peakNav = Math.max(peakNav, navRatio);
        const decisions = cfg.riskEngine.preTradeCheck({
          barIndex: i,
          drawdown: { navRatio, peakNav },
          venueCap: { venueId: cfg.venue.venueId, liveNotionalUnits: venueLiveNotional, addNotionalUnits: notionalLeg * 2n },
          exposure: {
            positions: [{
              pairId: cfg.riskOpts?.pairId ?? `${cfg.barsA[0]?.symbol}/${cfg.barsB[0]?.symbol}`,
              longUnits: openLongUnits,
              shortUnits: openShortUnits,
            }],
            intent: {
              pairId: cfg.riskOpts?.pairId ?? `${cfg.barsA[0]?.symbol}/${cfg.barsB[0]?.symbol}`,
              longUnits: notionalLeg,
              shortUnits: notionalLeg,
            },
          },
        });
        if (!decisions.every((d) => d.allow)) {
          blockedEntries++;
          // Strategy flipped its regime before returning the orders; rollback
          // so we can re-attempt the OPEN on a later bar.
          cfg.strategy.rollbackEntry();
          continue;
        }
      }

      // Group orders by symbol so we can pair the two legs. The mock venue
      // returns fills synchronously; we await each in order.
      const fills: Record<string, { side: Side; price: bigint; fees: bigint }> = {};
      for (const o of orders) {
        const fill = await cfg.venue.placeOrder({
          symbol: o.symbol,
          side: o.side,
          notionalUnits: o.notionalUnits,
          idempotencyKey: `backtest-${i}-${o.symbol}-${o.reason}`,
        });
        fills[o.symbol] = { side: o.side, price: fill.priceMicros, fees: fill.feesUnits };
      }

      const reason = orders[0].reason;
      const fillA = fills[a.symbol];
      const fillB = fills[b.symbol];

      if (reason === 'OPEN_LONG' || reason === 'OPEN_SHORT') {
        open = {
          openIndex: i,
          side: reason === 'OPEN_LONG' ? 'LONG' : 'SHORT',
          entryZ: zNow,
          openPriceA: fillA.price,
          openPriceB: fillB.price,
          openFeesUnits: fillA.fees + fillB.fees,
          notionalUnits: orders[0].notionalUnits,
        };
        // Update book-level exposure trackers for the next bar's risk check.
        venueLiveNotional += orders[0].notionalUnits * 2n;
        openLongUnits += orders[0].notionalUnits;
        openShortUnits += orders[0].notionalUnits;
      } else if (reason === 'CLOSE' && open !== null) {
        // P&L for a SHORT spread (sold A, bought B at open; reverse at close):
        //   pnlA = notional * (openA - closeA) / openA      (short A profits when A falls)
        //   pnlB = notional * (closeB - openB) / openB      (long B profits when B rises)
        // For LONG spread, flip the signs.
        const sign = open.side === 'LONG' ? 1n : -1n;
        const pnlA =
          (open.notionalUnits * sign * (fillA.price - open.openPriceA)) / open.openPriceA;
        const pnlB =
          (open.notionalUnits * -sign * (fillB.price - open.openPriceB)) / open.openPriceB;
        const grossPnl = pnlA + pnlB;
        const totalFees = open.openFeesUnits + fillA.fees + fillB.fees;
        const netPnl = grossPnl - totalFees;
        trades.push({
          openIndex: open.openIndex,
          closeIndex: i,
          side: open.side,
          entryZ: open.entryZ,
          exitZ: zNow,
          pnlUnits: netPnl,
          holdBars: i - open.openIndex,
        });
        if (cfg.repository) {
          // Persist the closed round-trip. Idempotency key combines runId +
          // openIndex so re-running the same backtest is replay-safe.
          await cfg.repository.insertTrade({
            venue: cfg.venue.venueId,
            symbolA: a.symbol,
            symbolB: b.symbol,
            side: open.side,
            entryZ: open.entryZ,
            exitZ: zNow,
            entryPriceAMicros: open.openPriceA,
            entryPriceBMicros: open.openPriceB,
            exitPriceAMicros: fillA.price,
            exitPriceBMicros: fillB.price,
            notionalUnits: open.notionalUnits,
            pnlUnits: netPnl,
            feesUnits: totalFees,
            openedAt: cfg.barsA[open.openIndex].timestamp,
            closedAt: a.timestamp,
            idempotencyKey: `${cfg.runId ?? 'run'}-${open.openIndex}`,
          });
        }
        pnlSoFar += netPnl;
        venueLiveNotional -= open.notionalUnits * 2n;
        if (venueLiveNotional < 0n) venueLiveNotional = 0n;
        openLongUnits -= open.notionalUnits;
        openShortUnits -= open.notionalUnits;
        if (openLongUnits < 0n) openLongUnits = 0n;
        if (openShortUnits < 0n) openShortUnits = 0n;
        open = null;
      }
    }

    return {
      trades,
      metrics: summarize(trades),
      spreadSeries,
      gateEvents: cfg.riskEngine ? cfg.riskEngine.drainEvents() : [],
      blockedEntries,
    };
  }
}
