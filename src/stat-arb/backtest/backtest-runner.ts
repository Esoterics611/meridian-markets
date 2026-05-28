import { Bar } from './bar';
import { BarContext, DesiredOrder, IStrategy } from './strategy.interface';
import { ITradingVenue, Side } from '../trading-venue.interface';
import { summarize, BacktestMetrics } from './pnl-attribution';
import { PairsStrategy, Regime } from './pairs-strategy';

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
}

export interface BacktestConfig {
  barsA: Bar[];
  barsB: Bar[];
  strategy: PairsStrategy;
  venue: ITradingVenue;
}

/** Stateless coordinator: feed → strategy → venue → metrics. */
export class BacktestRunner {
  async run(cfg: BacktestConfig): Promise<BacktestResult> {
    if (cfg.barsA.length !== cfg.barsB.length) {
      throw new Error('BacktestRunner.run: barsA and barsB must have same length');
    }
    const trades: TradeRecord[] = [];
    const spreadSeries: BacktestResult['spreadSeries'] = [];

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
        open = null;
      }
    }

    return {
      trades,
      metrics: summarize(trades),
      spreadSeries,
    };
  }
}
