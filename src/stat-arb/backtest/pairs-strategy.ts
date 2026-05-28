import { rollingZScore } from '../signal/z-score';
import { logSpread } from '../signal/spread';
import { BarContext, DesiredOrder, IStrategy } from './strategy.interface';

// Pairs trading strategy:
//   1. Compute the rolling log-spread S_t = log(A) - β log(B).
//   2. Take its rolling z-score over `zLookback` bars.
//   3. Enter SHORT spread (sell A, buy B) when z > +entryZ.
//      Enter LONG spread  (buy A, sell B) when z < -entryZ.
//      Exit (flat) when |z| < exitZ.
//
// β is configured up front (constant) — for the demo this avoids re-running
// cointegration every bar. In production you'd re-fit β on a sliding window;
// see Phase 3 Step 2 in PHASED_PLAN.md.

export type Regime = 'LONG' | 'SHORT' | 'FLAT';

export interface PairsStrategyConfig {
  /** Hedge ratio. */
  beta: number;
  /** Rolling lookback bars for the z-score. */
  zLookback: number;
  /** z-score magnitude that triggers an entry. */
  entryZ: number;
  /** z-score magnitude inside which we exit. */
  exitZ: number;
  /** Per-leg notional, in 6-decimal USDC units. */
  notionalUnits: bigint;
}

export class PairsStrategy implements IStrategy {
  private regime: Regime = 'FLAT';

  constructor(private readonly cfg: PairsStrategyConfig) {}

  currentRegime(): Regime {
    return this.regime;
  }

  /** Last computed z-score, or NaN if not enough history yet. */
  lastZ = NaN;

  onBar(ctx: BarContext): DesiredOrder[] {
    const closesA = ctx.historyA.map((b) => b.close);
    const closesB = ctx.historyB.map((b) => b.close);
    if (closesA.length < this.cfg.zLookback + 1) {
      this.lastZ = NaN;
      return [];
    }
    const spread = logSpread(closesA, closesB, this.cfg.beta);
    const z = rollingZScore(spread, this.cfg.zLookback);
    const zNow = z[z.length - 1];
    this.lastZ = zNow;
    if (!Number.isFinite(zNow)) return [];

    const orders: DesiredOrder[] = [];
    const n = this.cfg.notionalUnits;
    const symA = ctx.a.symbol;
    const symB = ctx.b.symbol;

    if (this.regime === 'FLAT') {
      if (zNow > this.cfg.entryZ) {
        // Spread is high → short A, long B.
        this.regime = 'SHORT';
        orders.push({ symbol: symA, side: 'SELL', notionalUnits: n, reason: 'OPEN_SHORT' });
        orders.push({ symbol: symB, side: 'BUY', notionalUnits: n, reason: 'OPEN_SHORT' });
      } else if (zNow < -this.cfg.entryZ) {
        this.regime = 'LONG';
        orders.push({ symbol: symA, side: 'BUY', notionalUnits: n, reason: 'OPEN_LONG' });
        orders.push({ symbol: symB, side: 'SELL', notionalUnits: n, reason: 'OPEN_LONG' });
      }
    } else if (Math.abs(zNow) < this.cfg.exitZ) {
      // Close back to flat.
      if (this.regime === 'SHORT') {
        orders.push({ symbol: symA, side: 'BUY', notionalUnits: n, reason: 'CLOSE' });
        orders.push({ symbol: symB, side: 'SELL', notionalUnits: n, reason: 'CLOSE' });
      } else {
        orders.push({ symbol: symA, side: 'SELL', notionalUnits: n, reason: 'CLOSE' });
        orders.push({ symbol: symB, side: 'BUY', notionalUnits: n, reason: 'CLOSE' });
      }
      this.regime = 'FLAT';
    }
    return orders;
  }
}
