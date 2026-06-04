import { logSpread } from '../signal/spread';
import { ouFit, bertramThresholds, OuFit } from '../signal/ou';
import {
  slidingCointegration,
  SlidingCointegrationResult,
} from '../signal/sliding-cointegration';
import { BarContext, DesiredOrder, IStrategy } from '../backtest/strategy.interface';

// OuSpreadStrategy — course §3 (OU process) realised as a live/backtest strategy.
//
// Where PairsStrategy (course §2) trades a *rolling z-score* of the log-spread,
// this strategy fits an Ornstein-Uhlenbeck process to the same spread and trades
// the simplified Bertram (2010) optimal bands:
//
//   1. S_t = log(A) − β log(B)                        (same spread as §2)
//   2. Over the last `ouWindow` bars, fit dX = θ(μ − X)dt + σ dW  → {θ, μ, σ}
//   3. Equilibrium std  σ_eq = σ / √(2θ)              (stationary spread vol)
//   4. Bertram bands (distances from μ), widened by transaction cost:
//        entry = k·σ_eq,  exit = 0.25·σ_eq,  k = 1 + √(cost·100)
//   5. deviation d = S_t − μ
//        FLAT  & d > +entry → SHORT spread (sell A / buy B), expect revert down
//        FLAT  & d < −entry → LONG  spread (buy A / sell B), expect revert up
//        IN-POS & |d| < exit → CLOSE
//
// The OU fit only trades a *mean-reverting* series: θ must be > 0, else the
// series is trending/random-walk and we stand aside (no Bertram bands exist).
// This is the §3 discipline — never trade a spread that has lost its pull.
//
// `lastZ` is exposed as the *standardised* deviation d / σ_eq so the dashboard's
// z-score chart and the risk gates work unchanged against this strategy — a
// d/σ_eq of +2 means "two equilibrium-σ rich", directly comparable to a §2 z.

export type Regime = 'LONG' | 'SHORT' | 'FLAT';

export interface OuBetaRefitConfig {
  enabled: boolean;
  /** Bars in the rolling cointegration fit window for β. */
  windowBars: number;
  /** Refit cadence in bars. */
  everyBars: number;
  /** Block entries when the most recent β-fit's p-value exceeds this. */
  pValueGate?: number;
}

export interface OuSpreadStrategyConfig {
  /** Initial hedge ratio. Replaced by the rolling cointegration fit when betaRefit is on. */
  beta: number;
  /** Rolling window (bars) over which the OU process is fit each bar. */
  ouWindow: number;
  /** Round-trip transaction-cost fraction used to widen the Bertram entry band. */
  txCostFraction: number;
  /** Per-leg notional, 6-decimal USDC units. */
  notionalUnits: bigint;
  /** Floor on θ to treat the series as mean-reverting (guards near-random-walk fits). Default 1e-4. */
  minTheta?: number;
  /** Optional sliding-β refit (same machinery as PairsStrategy). Default off. */
  betaRefit?: OuBetaRefitConfig;
}

export type GateEventKind = 'P_VALUE_BLOCK' | 'NOT_MEAN_REVERTING';
export interface GateEvent {
  kind: GateEventKind;
  barIndex: number;
  reason: string;
  zAtBlock: number;
}

export class OuSpreadStrategy implements IStrategy {
  private regime: Regime = 'FLAT';
  private lastFit: SlidingCointegrationResult | null = null;
  private fitHistory: SlidingCointegrationResult[] = [];
  private gateEvents: GateEvent[] = [];
  private lastOu: OuFit | null = null;

  /** Last standardised deviation d/σ_eq (NaN until enough history). */
  lastZ = NaN;

  constructor(private readonly cfg: OuSpreadStrategyConfig) {}

  currentRegime(): Regime {
    return this.regime;
  }

  currentBeta(): number {
    return this.lastFit ? this.lastFit.beta : this.cfg.beta;
  }

  /** Latest OU fit, or null before the first window completes. */
  latestOuFit(): OuFit | null {
    return this.lastOu;
  }

  refitHistory(): SlidingCointegrationResult[] {
    return this.fitHistory.slice();
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
    this.lastOu = null;
    this.lastZ = NaN;
  }

  onBar(ctx: BarContext): DesiredOrder[] {
    const closesA = ctx.historyA.map((b) => b.close);
    const closesB = ctx.historyB.map((b) => b.close);

    // Optional sliding-β cointegration refit (mirrors PairsStrategy).
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

    if (closesA.length < this.cfg.ouWindow + 1) {
      this.lastZ = NaN;
      return [];
    }

    const beta = this.currentBeta();
    const spreadFull = logSpread(closesA, closesB, beta);
    const window = spreadFull.slice(spreadFull.length - this.cfg.ouWindow);
    const spreadNow = spreadFull[spreadFull.length - 1];

    let fit: OuFit;
    try {
      fit = ouFit(window);
    } catch {
      this.lastZ = NaN;
      return [];
    }
    this.lastOu = fit;

    const minTheta = this.cfg.minTheta ?? 1e-4;
    const sigmaEq = fit.theta > 0 ? fit.sigma / Math.sqrt(2 * fit.theta) : NaN;
    const deviation = spreadNow - fit.mu;
    const zStd = Number.isFinite(sigmaEq) && sigmaEq > 0 ? deviation / sigmaEq : NaN;
    this.lastZ = zStd;

    // Not mean-reverting → no Bertram bands → stand aside (and log if we *would*
    // have wanted to act, i.e. a meaningful deviation exists).
    if (!(fit.theta > minTheta) || !Number.isFinite(zStd)) {
      if (this.regime === 'FLAT' && Math.abs(deviation) > 0) {
        this.gateEvents.push({
          kind: 'NOT_MEAN_REVERTING',
          barIndex: ctx.index,
          reason: `theta ${fit.theta.toFixed(5)} <= minTheta ${minTheta}`,
          zAtBlock: Number.isFinite(zStd) ? zStd : 0,
        });
      }
      return [];
    }

    const bands = bertramThresholds(fit, this.cfg.txCostFraction);
    // bands.entry / bands.exit are distances in spread units (multiples of σ_eq).
    const entryDist = bands.entry;
    const exitDist = bands.exit;

    const orders: DesiredOrder[] = [];
    const n = this.cfg.notionalUnits;
    const symA = ctx.a.symbol;
    const symB = ctx.b.symbol;

    if (this.regime === 'FLAT') {
      const gate = this.cfg.betaRefit?.pValueGate;
      if (gate !== undefined && this.lastFit && this.lastFit.pValue > gate) {
        if (Math.abs(deviation) > entryDist) {
          this.gateEvents.push({
            kind: 'P_VALUE_BLOCK',
            barIndex: ctx.index,
            reason: `pValue ${this.lastFit.pValue.toFixed(3)} > gate ${gate}`,
            zAtBlock: zStd,
          });
        }
        return [];
      }
      if (deviation > entryDist) {
        this.regime = 'SHORT';
        orders.push({ symbol: symA, side: 'SELL', notionalUnits: n, reason: 'OPEN_SHORT' });
        orders.push({ symbol: symB, side: 'BUY', notionalUnits: n, reason: 'OPEN_SHORT' });
      } else if (deviation < -entryDist) {
        this.regime = 'LONG';
        orders.push({ symbol: symA, side: 'BUY', notionalUnits: n, reason: 'OPEN_LONG' });
        orders.push({ symbol: symB, side: 'SELL', notionalUnits: n, reason: 'OPEN_LONG' });
      }
    } else if (Math.abs(deviation) < exitDist) {
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
