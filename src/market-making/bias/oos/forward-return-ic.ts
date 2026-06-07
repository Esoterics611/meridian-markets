// Forward-return IC — the honest, OOS measurement that a directional BIAS signal
// actually predicts forward price return (DIRECTIONAL_MM_STRATEGY.md §9, the gate
// before the axed maker rests at q*=bias·Q_max). A bias is alpha, and "a blind bias
// is just a leveraged way to lose", so before any signal sizes live carry it must
// show a positive OOS forward-return correlation per coin / per asset class.
//
// This module is the PURE, unit-tested core (no network) of that gate. It reuses the
// repo's existing honesty machinery rather than reinventing it:
//   • purged k-fold + embargo (purged-kfold.ts) so train/test forward-return windows
//     never overlap — the multi-bar forward label leaks otherwise;
//   • the deflated-Sharpe / PSR module (deflated-sharpe.ts) for the multiple-testing
//     correction — we test several coins × signals × horizons, so we report the
//     DEFLATED stat, not the best raw one.
//
// The bridge from "signal" to "deflatable stat": at each time t a signal s_t and a
// forward return r_{t→t+h} give an OBSERVATION-LEVEL P&L = sign(s_t)·r_{t→t+h} (the
// direction-only payoff a bias of fixed size would earn each step), and the mean/σ
// of that pooled OOS stream is a per-observation Sharpe the existing deflatedSharpe()
// consumes unchanged. Alongside it we report the rank IC (Spearman) + Pearson IC as
// the effect-size read.

import { purgedKFoldSplits } from '../../../stat-arb/research/purged-kfold';
import {
  SharpeStats,
  sharpeStats,
  deflatedSharpe,
  DeflatedSharpeResult,
} from '../../../stat-arb/research/deflated-sharpe';

/** A signal value paired with the FORWARD return it is meant to predict. */
export interface SignalForwardPair {
  /** Signal value observed using data up to t only (no look-ahead). */
  signal: number;
  /** Realised return from t to t+h (the label). */
  forwardReturn: number;
}

/** Pearson correlation of two equal-length series (0 if degenerate). */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** Average ranks (ties share the mean rank) of a series — for Spearman. */
function averageRanks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank over the tie block
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation — the robust IC (insensitive to fat tails/outliers). */
export function spearman(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  return pearson(averageRanks(xs.slice(0, n)), averageRanks(ys.slice(0, n)));
}

/**
 * Build (signal, forwardReturn) pairs from a price series and a per-bar signal.
 * `signals[i]` MUST be computed from prices up to index i only (the caller owns
 * that — e.g. trailing-funding sign or a trailing-momentum return). The forward
 * return is log(P[i+horizon]/P[i]); pairs whose forward window runs off the end
 * (or whose signal is non-finite / exactly 0) are dropped.
 *
 * Dropping signal==0 is deliberate: a flat signal expresses NO view (sign 0 ⇒ no
 * position), so it should neither help nor hurt the IC — it is simply not a trade.
 */
export function buildSignalForwardPairs(
  prices: number[],
  signals: number[],
  horizonBars: number,
  opts: { dropZeroSignal?: boolean } = {},
): SignalForwardPair[] {
  const dropZero = opts.dropZeroSignal ?? true;
  const out: SignalForwardPair[] = [];
  const n = Math.min(prices.length, signals.length);
  for (let i = 0; i + horizonBars < n; i++) {
    const s = signals[i];
    const p0 = prices[i];
    const p1 = prices[i + horizonBars];
    if (!Number.isFinite(s) || !Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
    if (dropZero && s === 0) continue;
    out.push({ signal: s, forwardReturn: Math.log(p1 / p0) });
  }
  return out;
}

/**
 * The per-observation direction-only P&L stream: sign(signal)·forwardReturn. This
 * is what a fixed-size bias on the signal's side would earn each step, and the
 * stream whose Sharpe the deflated-Sharpe gate judges. (A long-the-signal payoff:
 * positive when the signal's sign matched the forward move.)
 */
export function directionPnls(pairs: SignalForwardPair[]): number[] {
  return pairs.map((p) => Math.sign(p.signal) * p.forwardReturn);
}

export interface IcReport {
  /** Pearson IC: corr(signal, forwardReturn). Effect size, sign-and-magnitude. */
  pearsonIc: number;
  /** Spearman (rank) IC — the robust effect size. */
  spearmanIc: number;
  /** Mean of the direction-only P&L (sign(signal)·fwdRet) — the realised edge/step. */
  meanDirectionPnl: number;
  /** Hit rate: fraction of observations where sign(signal)==sign(forwardReturn). */
  hitRate: number;
  /** Number of usable (signal, forwardReturn) observations. */
  n: number;
}

/** In-sample IC + direction stats over a set of pairs (no CV — the raw read). */
export function computeIc(pairs: SignalForwardPair[]): IcReport {
  const sig = pairs.map((p) => p.signal);
  const fwd = pairs.map((p) => p.forwardReturn);
  const dir = directionPnls(pairs);
  const n = pairs.length;
  const mean = n ? dir.reduce((a, b) => a + b, 0) / n : 0;
  let hits = 0;
  for (const p of pairs) if (Math.sign(p.signal) === Math.sign(p.forwardReturn) && p.forwardReturn !== 0) hits++;
  return {
    pearsonIc: pearson(sig, fwd),
    spearmanIc: spearman(sig, fwd),
    meanDirectionPnl: mean,
    hitRate: n ? hits / n : 0,
    n,
  };
}

export interface OosIcConfig {
  /** Number of purged folds (>=2). */
  folds: number;
  /**
   * Embargo/purge as a fraction of n on EACH side of a test fold. The forward
   * label spans `horizonBars`, so the gap must cover it — oosForwardReturnIc lifts
   * this to max(embargoFrac, horizonBars/n) automatically.
   */
  embargoFrac: number;
  /**
   * Total trials in the whole sweep (coins × signals × horizons) for the
   * selection-bias haircut — pass the FULL trial count so the deflation is honest.
   */
  trials: number;
  /** Cross-trial Sharpe dispersion σ_SR (from the sweep); 0 ⇒ no selection haircut. */
  sigmaSR: number;
}

export interface OosIcReport {
  /** Pooled OOS Pearson IC (over all test-fold observations). */
  pearsonIc: number;
  /** Pooled OOS Spearman IC. */
  spearmanIc: number;
  /** Pooled OOS hit rate. */
  hitRate: number;
  /** Mean OOS direction P&L per observation. */
  meanDirectionPnl: number;
  /** Sharpe/skew/kurtosis of the pooled OOS direction-P&L stream. */
  stats: SharpeStats;
  /** Deflated-Sharpe / PSR of that pooled OOS stream (the multiple-testing read). */
  deflated: DeflatedSharpeResult;
  /** Number of OOS observations pooled across folds. */
  n: number;
  /** Per-fold OOS Spearman ICs (for a stability eyeball). */
  foldSpearmanIc: number[];
}

/**
 * The OOS gate for one (coin, signal, horizon): purged k-fold over the
 * (signal, forwardReturn) pairs — each fold's test block is scored on its OWN
 * observations only, with the purge+embargo gap (covering the forward horizon)
 * removed so no test label leaks into a neighbouring fold. Pools the test-fold
 * observations → IC + a deflated Sharpe of the direction-only P&L stream.
 *
 * NOTE: these signals are parameter-free given their definition (a trailing
 * funding sign, a trailing momentum return), so there is no per-fold "fit" to
 * leak — the purge/embargo is purely about the OVERLAPPING FORWARD LABEL, which
 * is the real leakage source for a horizon>1 forward-return study.
 */
export function oosForwardReturnIc(
  pairs: SignalForwardPair[],
  horizonBars: number,
  cfg: OosIcConfig,
): OosIcReport {
  const n = pairs.length;
  if (n < cfg.folds) {
    const ic = computeIc(pairs);
    const stats = sharpeStats(directionPnls(pairs));
    return {
      pearsonIc: ic.pearsonIc,
      spearmanIc: ic.spearmanIc,
      hitRate: ic.hitRate,
      meanDirectionPnl: ic.meanDirectionPnl,
      stats,
      deflated: deflatedSharpe(stats.sharpe, stats.n, stats.skew, stats.kurtosis, cfg.trials, cfg.sigmaSR),
      n,
      foldSpearmanIc: [],
    };
  }
  // Embargo must cover the forward horizon (the label spans `horizonBars`), else a
  // test observation's forward window overlaps the adjacent train/test block.
  const embargoFrac = Math.max(cfg.embargoFrac, n > 0 ? horizonBars / n : 0);
  const splits = purgedKFoldSplits(n, cfg.folds, embargoFrac);
  const oosPairs: SignalForwardPair[] = [];
  const foldSpearmanIc: number[] = [];
  for (const s of splits) {
    const testPairs = pairs.slice(s.testStart, s.testEnd);
    if (testPairs.length >= 2) {
      foldSpearmanIc.push(spearman(testPairs.map((p) => p.signal), testPairs.map((p) => p.forwardReturn)));
    }
    for (const p of testPairs) oosPairs.push(p);
  }
  const ic = computeIc(oosPairs);
  const dir = directionPnls(oosPairs);
  const stats = sharpeStats(dir);
  const deflated = deflatedSharpe(stats.sharpe, stats.n, stats.skew, stats.kurtosis, cfg.trials, cfg.sigmaSR);
  return {
    pearsonIc: ic.pearsonIc,
    spearmanIc: ic.spearmanIc,
    hitRate: ic.hitRate,
    meanDirectionPnl: ic.meanDirectionPnl,
    stats,
    deflated,
    n: oosPairs.length,
    foldSpearmanIc,
  };
}

export type BiasVerdict = 'VALIDATED' | 'NOT_VALIDATED' | 'INSUFFICIENT' | 'INCONCLUSIVE';

export interface VerdictConfig {
  /** Min pooled OOS observations to judge at all. Default 30. */
  minObs?: number;
  /** Deflated-Sharpe bar for VALIDATED (P that the edge beats selection bias). Default 0.95. */
  dsrBar?: number;
  /** PSR floor below which the read is NOISE → NOT_VALIDATED. Default 0.90. */
  psrFloor?: number;
  /** Spearman IC must exceed this in magnitude (and match a positive edge). Default 0. */
  minAbsSpearman?: number;
}

/**
 * The verdict for one (coin, signal, horizon): VALIDATED only when the deflated
 * Sharpe of the OOS direction stream clears the bar AND there are enough
 * observations AND the rank IC agrees in sign with a positive edge. A directional
 * signal "validates" when leaning the book on its sign would have made money OOS
 * after the multiple-testing haircut — nothing weaker is allowed to size carry.
 */
export function verdictFor(r: OosIcReport, cfg: VerdictConfig = {}): BiasVerdict {
  const minObs = cfg.minObs ?? 30;
  const dsrBar = cfg.dsrBar ?? 0.95;
  const psrFloor = cfg.psrFloor ?? 0.9;
  const minAbsSpearman = cfg.minAbsSpearman ?? 0;
  if (r.n < minObs) return 'INSUFFICIENT';
  const edgePositive = r.meanDirectionPnl > 0 && r.spearmanIc > minAbsSpearman;
  if (!edgePositive) return 'NOT_VALIDATED';
  if (r.deflated.dsr >= dsrBar) return 'VALIDATED';
  if (r.deflated.psr < psrFloor) return 'NOT_VALIDATED';
  return 'INCONCLUSIVE';
}

/**
 * A sane magnitude cap for a VALIDATED bias: scale conviction by the OOS rank IC,
 * clamped well below 1 so even a strong signal never rests the book at full
 * inventory on one window's read. |b|_cap = clamp(k·|spearmanIc|, 0, hardCap).
 * Default k=4, hardCap=0.5 → an IC of ~0.1 maps to a 0.4 bias, ≥0.125 to the cap.
 */
export function biasMagnitudeCap(spearmanIc: number, k = 4, hardCap = 0.5): number {
  const m = Math.abs(spearmanIc) * k;
  return Math.max(0, Math.min(hardCap, m));
}
