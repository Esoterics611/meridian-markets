import { ewmaZScore } from '../signal/z-score';
import { logSpread } from '../signal/spread';
import {
  slidingCointegration,
  SlidingCointegrationResult,
} from '../signal/sliding-cointegration';
import { entryClearsFees, stdev } from '../signal/fee-gate';
import { BarContext, DesiredOrder, IStrategy } from '../backtest/strategy.interface';

// BollingerPairsStrategy — course §2 cointegration pairs, EWMA variant.
//
// Identical skeleton to PairsStrategy (log-spread → z-score → ±entry/exit
// bands), but the z-score is an *exponentially weighted* moving z (EWMA mean +
// EWMA variance) instead of a flat rolling window. The course §2.5 calls this
// out as the standard variation: EWMA reacts faster to a regime change in the
// spread's mean/vol and has no hard "window edge" artefact, at the cost of more
// sensitivity to a single outlier bar.
//
// `lambda` is the decay in (0,1): closer to 1 = longer memory (≈ a wide
// Bollinger window); closer to 0 = jumpy. Entry/exit thresholds are in z units,
// directly comparable to PairsStrategy so the same risk gates and dashboard
// apply. Satisfies both IStrategy (backtest) and the structural LiveStrategy
// (live paper loop).

export type Regime = 'LONG' | 'SHORT' | 'FLAT';

export interface BollingerBetaRefitConfig {
  enabled: boolean;
  windowBars: number;
  everyBars: number;
  pValueGate?: number;
}

export interface BollingerPairsStrategyConfig {
  /** Initial hedge ratio (replaced by rolling cointegration fit when betaRefit on). */
  beta: number;
  /** EWMA decay in (0,1). ~0.94 ≈ a 30-bar effective window. */
  lambda: number;
  /** Bars of warm-up before the EWMA z is trusted enough to trade. */
  warmupBars: number;
  /** z-score magnitude that triggers an entry. */
  entryZ: number;
  /** z-score magnitude inside which we exit. */
  exitZ: number;
  /** Per-leg notional, 6-decimal USDC units. */
  notionalUnits: bigint;
  /** Optional sliding-β refit. */
  betaRefit?: BollingerBetaRefitConfig;
  /** Round-trip taker fee in bps for the fee-aware entry gate. Default off. See signal/fee-gate.ts. */
  feeBps?: number;
  /** Margin-of-safety multiple on the fee floor. Default 1. */
  minEdgeMultiple?: number;
}

export type GateEventKind = 'P_VALUE_BLOCK' | 'FEE_GATE';
export interface GateEvent {
  kind: GateEventKind;
  barIndex: number;
  reason: string;
  zAtBlock: number;
}

export class BollingerPairsStrategy implements IStrategy {
  private regime: Regime = 'FLAT';
  private lastFit: SlidingCointegrationResult | null = null;
  private fitHistory: SlidingCointegrationResult[] = [];
  private gateEvents: GateEvent[] = [];

  lastZ = NaN;

  constructor(private readonly cfg: BollingerPairsStrategyConfig) {}

  currentRegime(): Regime {
    return this.regime;
  }

  currentBeta(): number {
    return this.lastFit ? this.lastFit.beta : this.cfg.beta;
  }

  refitHistory(): SlidingCointegrationResult[] {
    return this.fitHistory.slice();
  }

  latestRefit(): SlidingCointegrationResult | null {
    return this.lastFit;
  }

  gateLog(): GateEvent[] {
    return this.gateEvents.slice();
  }

  rollbackEntry(): void {
    this.regime = 'FLAT';
  }

  /** Resume in a held position on boot (restart-safe books): re-enter the regime
   *  so the next bar evaluates an EXIT, not a fresh entry. */
  restorePosition(side: 'LONG' | 'SHORT'): void {
    this.regime = side;
  }

  reset(): void {
    this.regime = 'FLAT';
    this.lastFit = null;
    this.fitHistory = [];
    this.gateEvents = [];
    this.lastZ = NaN;
  }

  onBar(ctx: BarContext): DesiredOrder[] {
    const closesA = ctx.historyA.map((b) => b.close);
    const closesB = ctx.historyB.map((b) => b.close);

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
          rc.windowBars,
        );
        if (fits.length > 0) {
          const fit = { ...fits[0], fittedAtIndex: ctx.index };
          this.lastFit = fit;
          this.fitHistory.push(fit);
        }
      }
    }

    if (closesA.length < this.cfg.warmupBars + 1) {
      this.lastZ = NaN;
      return [];
    }

    const beta = this.currentBeta();
    const spread = logSpread(closesA, closesB, beta);
    const z = ewmaZScore(spread, this.cfg.lambda);
    const zNow = z[z.length - 1];
    this.lastZ = zNow;
    if (!Number.isFinite(zNow)) return [];

    const orders: DesiredOrder[] = [];
    const n = this.cfg.notionalUnits;
    const symA = ctx.a.symbol;
    const symB = ctx.b.symbol;

    if (this.regime === 'FLAT') {
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
      // Fee-aware entry gate (EWMA variant): σ_spread over an EWMA-equivalent
      // window ≈ 1/(1−λ). Refuse entries whose expected reversion can't clear fees.
      const wantsEntry = zNow > this.cfg.entryZ || zNow < -this.cfg.entryZ;
      if (wantsEntry && this.cfg.feeBps !== undefined) {
        const effWindow = Math.min(spread.length, Math.max(10, Math.round(1 / (1 - this.cfg.lambda))));
        const sigmaSpread = stdev(spread.slice(-effWindow));
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
