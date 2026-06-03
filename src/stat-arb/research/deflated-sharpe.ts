// Deflated Sharpe Ratio (DSR) + Probabilistic Sharpe Ratio (PSR) — Bailey &
// López de Prado. The desk scans ~80–90 cointegrated pairs per asset class and
// reports the best; reporting the max of many trials is pure selection bias, so
// a raw Sharpe overstates the edge. This module quantifies the haircut:
//
//   PSR(SR*)  = P(true Sharpe > SR*) given the sample length + skew/kurtosis of
//               the return series. With SR* = 0 it answers "is the Sharpe even
//               positive, or could it be noise on this few observations?"
//   E[max SR] = the Sharpe you'd EXPECT to see as the best of N independent
//               trials purely by luck, given the dispersion of trial Sharpes.
//   DSR       = PSR with SR* = E[max SR] — i.e. P(the observed Sharpe beats what
//               selection bias alone would have produced). DSR ≳ 0.95 is the bar.
//
// Everything is in "per-trade" Sharpe (mean/σ of trade P&L), matching
// pnl-attribution.ts — no annualisation. Skew/kurtosis are the sample moments
// of the trade-P&L series (kurtosis is NON-excess: 3 for a normal).

const EULER_MASCHERONI = 0.5772156649015329;

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Inverse standard normal CDF (quantile) — Acklam's rational approximation. */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export interface SharpeStats {
  /** Per-trade Sharpe: mean / sample-σ of the P&L series. */
  sharpe: number;
  /** Sample skewness. */
  skew: number;
  /** Sample kurtosis (NON-excess: 3 for a normal). */
  kurtosis: number;
  /** Number of observations. */
  n: number;
}

/** Sharpe + higher moments of a P&L (or returns) series. */
export function sharpeStats(pnls: number[]): SharpeStats {
  const n = pnls.length;
  if (n < 2) return { sharpe: 0, skew: 0, kurtosis: 3, n };
  let mean = 0;
  for (const x of pnls) mean += x;
  mean /= n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of pnls) {
    const d = x - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  // Population central moments for skew/kurtosis; sample σ (n-1) for Sharpe, to
  // match pnl-attribution.ts.
  const var2 = m2 / n;
  const sd = Math.sqrt(var2);
  const sampleSd = Math.sqrt(m2 / (n - 1));
  const skew = sd > 0 ? m3 / n / (sd * sd * sd) : 0;
  const kurtosis = sd > 0 ? m4 / n / (var2 * var2) : 3;
  const sharpe = sampleSd > 0 ? mean / sampleSd : 0;
  return { sharpe, skew, kurtosis, n };
}

/**
 * Probabilistic Sharpe Ratio — P(true Sharpe > srStar) given sample length and
 * the return series' skew/kurtosis. Default srStar=0 ⇒ P(Sharpe is positive).
 */
export function probabilisticSharpe(
  sr: number,
  n: number,
  skew: number,
  kurtosis: number,
  srStar = 0,
): number {
  if (n < 2) return 0.5;
  // σ̂(SR) denominator: variance of the Sharpe estimator under non-normality.
  const denomVar = 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr;
  if (denomVar <= 0) return sr > srStar ? 1 : 0;
  const z = ((sr - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denomVar);
  return normalCdf(z);
}

/**
 * Expected MAX Sharpe across `trials` independent strategies whose individual
 * Sharpe estimates have standard deviation `sigmaSR` — i.e. the Sharpe selection
 * bias alone would hand you. ~0 for a single trial.
 */
export function expectedMaxSharpe(trials: number, sigmaSR: number): number {
  if (trials <= 1 || sigmaSR <= 0) return 0;
  const a = inverseNormalCdf(1 - 1 / trials);
  const b = inverseNormalCdf(1 - 1 / (trials * Math.E));
  return sigmaSR * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b);
}

export interface DeflatedSharpeResult {
  /** PSR against SR*=0 — is the Sharpe positive at all on this sample? */
  psr: number;
  /** The selection-bias benchmark Sharpe (E[max] over `trials`). */
  expectedMaxSharpe: number;
  /** DSR — P(observed Sharpe beats the selection-bias benchmark). The bar is ~0.95. */
  dsr: number;
  trials: number;
  sigmaSR: number;
}

/**
 * Deflated Sharpe — discounts the observed Sharpe for (a) short samples +
 * non-normality (via PSR) and (b) having been selected as the best of `trials`
 * (via E[max] as the benchmark). `sigmaSR` is the dispersion of Sharpes ACROSS
 * the trials; pass the cross-pair Sharpe std from the scan when you have it, else
 * a CV-fold estimate (the caller documents which).
 */
export function deflatedSharpe(
  sr: number,
  n: number,
  skew: number,
  kurtosis: number,
  trials: number,
  sigmaSR: number,
): DeflatedSharpeResult {
  const emax = expectedMaxSharpe(trials, sigmaSR);
  return {
    psr: probabilisticSharpe(sr, n, skew, kurtosis, 0),
    expectedMaxSharpe: emax,
    dsr: probabilisticSharpe(sr, n, skew, kurtosis, emax),
    trials,
    sigmaSR,
  };
}
