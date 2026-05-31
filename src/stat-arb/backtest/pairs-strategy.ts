import { rollingZScore } from '../signal/z-score';
import { logSpread } from '../signal/spread';
import {
  slidingCointegration,
  SlidingCointegrationResult,
} from '../signal/sliding-cointegration';
import { entryClearsFees, stdev } from '../signal/fee-gate';
import { BarContext, DesiredOrder, IStrategy } from './strategy.interface';

// Pairs trading strategy:
//   1. Compute the rolling log-spread S_t = log(A) - β log(B).
//   2. Take its rolling z-score over `zLookback` bars.
//   3. Enter SHORT spread (sell A, buy B) when z > +entryZ.
//      Enter LONG spread  (buy A, sell B) when z < -entryZ.
//      Exit (flat) when |z| < exitZ.
//
// β can be pinned at construction (fast, deterministic — used by the synthetic
// demo) OR re-fit every N bars on a rolling window via `betaRefit`. When
// re-fitting, the strategy also gates new entries on the cached p-value.

export type Regime = 'LONG' | 'SHORT' | 'FLAT';

export interface BetaRefitConfig {
  enabled: boolean;
  /** Bars in the rolling fit window. */
  windowBars: number;
  /** Refit cadence in bars. */
  everyBars: number;
  /** Block entries when the most recent fit's p-value exceeds this. */
  pValueGate?: number;
}

export interface PairsStrategyConfig {
  /** Initial hedge ratio. When `betaRefit.enabled`, replaced by the latest fit once available. */
  beta: number;
  /** Rolling lookback bars for the z-score. */
  zLookback: number;
  /** z-score magnitude that triggers an entry. */
  entryZ: number;
  /** z-score magnitude inside which we exit. */
  exitZ: number;
  /** Per-leg notional, in 6-decimal USDC units. */
  notionalUnits: bigint;
  /** Optional sliding-β refit. Default disabled (preserves Session 5 demo determinism). */
  betaRefit?: BetaRefitConfig;
  /**
   * Round-trip taker fee in bps for the fee-aware entry gate. When set (> 0), an
   * entry is only taken if the expected reversion (|z|−exitZ)·σ_spread clears
   * the 4-leg round-trip cost × `minEdgeMultiple`. Default undefined = gate off
   * (fee-blind, preserves prior determinism). See signal/fee-gate.ts.
   */
  feeBps?: number;
  /** Margin-of-safety multiple on the fee floor. Default 1. Higher = more selective. */
  minEdgeMultiple?: number;
}

export type GateEventKind = 'P_VALUE_BLOCK' | 'FEE_GATE';
export interface GateEvent {
  kind: GateEventKind;
  barIndex: number;
  reason: string;
  /** Z-score at the time the gate fired (informational only). */
  zAtBlock: number;
}

export class PairsStrategy implements IStrategy {
  private regime: Regime = 'FLAT';
  /** Last cached refit, if betaRefit is enabled. */
  private lastFit: SlidingCointegrationResult | null = null;
  private fitHistory: SlidingCointegrationResult[] = [];
  private gateEvents: GateEvent[] = [];

  constructor(private readonly cfg: PairsStrategyConfig) {}

  currentRegime(): Regime {
    return this.regime;
  }

  /** Last computed z-score, or NaN if not enough history yet. */
  lastZ = NaN;

  /** Returns a defensive copy of the cumulative refit history (for the dashboard). */
  refitHistory(): SlidingCointegrationResult[] {
    return this.fitHistory.slice();
  }

  /** Last cached fit (or null if no refits yet). */
  latestRefit(): SlidingCointegrationResult | null {
    return this.lastFit;
  }

  /** Cumulative gate events so far. */
  gateLog(): GateEvent[] {
    return this.gateEvents.slice();
  }

  /** Restore the strategy to FLAT after the runner rejects an OPEN intent. */
  rollbackEntry(): void {
    this.regime = 'FLAT';
  }

  /** Wipe all per-pair state so the instance can be reused on a different pair. */
  reset(): void {
    this.regime = 'FLAT';
    this.lastFit = null;
    this.fitHistory = [];
    this.gateEvents = [];
    this.lastZ = NaN;
  }

  /** β actually in use right now: cached refit if available, else the constructor value. */
  currentBeta(): number {
    return this.lastFit ? this.lastFit.beta : this.cfg.beta;
  }

  onBar(ctx: BarContext): DesiredOrder[] {
    const closesA = ctx.historyA.map((b) => b.close);
    const closesB = ctx.historyB.map((b) => b.close);

    // Sliding-β refit. Only refit when we have at least one window of bars AND
    // the bar index aligns with the cadence. We then keep the most-recent fit.
    if (this.cfg.betaRefit?.enabled) {
      const rc = this.cfg.betaRefit;
      const ready = ctx.index >= rc.windowBars - 1;
      const dueByCadence =
        ready && (ctx.index - (rc.windowBars - 1)) % rc.everyBars === 0;
      if (dueByCadence) {
        const logA = closesA.map((c) => Math.log(c));
        const logB = closesB.map((c) => Math.log(c));
        const fits = slidingCointegration(
          logA.slice(ctx.index - rc.windowBars + 1, ctx.index + 1),
          logB.slice(ctx.index - rc.windowBars + 1, ctx.index + 1),
          rc.windowBars,
          rc.windowBars, // single-fit on this exact window
        );
        if (fits.length > 0) {
          const fit = { ...fits[0], fittedAtIndex: ctx.index };
          this.lastFit = fit;
          this.fitHistory.push(fit);
        }
      }
    }

    if (closesA.length < this.cfg.zLookback + 1) {
      this.lastZ = NaN;
      return [];
    }
    const beta = this.currentBeta();
    const spread = logSpread(closesA, closesB, beta);
    const z = rollingZScore(spread, this.cfg.zLookback);
    const zNow = z[z.length - 1];
    this.lastZ = zNow;
    if (!Number.isFinite(zNow)) return [];

    const orders: DesiredOrder[] = [];
    const n = this.cfg.notionalUnits;
    const symA = ctx.a.symbol;
    const symB = ctx.b.symbol;

    if (this.regime === 'FLAT') {
      // p-value gate: refuse new entries if the most recent fit lost confidence.
      const gate = this.cfg.betaRefit?.pValueGate;
      if (gate !== undefined && this.lastFit && this.lastFit.pValue > gate) {
        if (zNow > this.cfg.entryZ || zNow < -this.cfg.entryZ) {
          this.gateEvents.push({
            kind: 'P_VALUE_BLOCK',
            barIndex: ctx.index,
            reason: `pValue ${this.lastFit.pValue.toFixed(3)} > gate ${gate}`,
            zAtBlock: zNow,
          });
        }
        return [];
      }
      // Fee-aware entry gate: refuse a trade whose expected reversion can't clear
      // the round-trip fee. Routes sub-fee spreads away from taker stat-arb.
      const wantsEntry = zNow > this.cfg.entryZ || zNow < -this.cfg.entryZ;
      if (wantsEntry && this.cfg.feeBps !== undefined) {
        const sigmaSpread = stdev(spread.slice(-this.cfg.zLookback));
        if (!entryClearsFees(zNow, this.cfg.exitZ, sigmaSpread, this.cfg.feeBps, this.cfg.minEdgeMultiple ?? 1)) {
          this.gateEvents.push({
            kind: 'FEE_GATE',
            barIndex: ctx.index,
            reason: `expected edge below fee floor (feeBps ${this.cfg.feeBps})`,
            zAtBlock: zNow,
          });
          return [];
        }
      }
      if (zNow > this.cfg.entryZ) {
        this.regime = 'SHORT';
        orders.push({ symbol: symA, side: 'SELL', notionalUnits: n, reason: 'OPEN_SHORT' });
        orders.push({ symbol: symB, side: 'BUY', notionalUnits: n, reason: 'OPEN_SHORT' });
      } else if (zNow < -this.cfg.entryZ) {
        this.regime = 'LONG';
        orders.push({ symbol: symA, side: 'BUY', notionalUnits: n, reason: 'OPEN_LONG' });
        orders.push({ symbol: symB, side: 'SELL', notionalUnits: n, reason: 'OPEN_LONG' });
      }
    } else if (Math.abs(zNow) < this.cfg.exitZ) {
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
