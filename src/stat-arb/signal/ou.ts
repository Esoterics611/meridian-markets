import { ols } from './_math';

// Ornstein-Uhlenbeck fitting + simplified Bertram (2010) trading thresholds.
//
// Discrete-time fit of  dX_t = θ(μ − X_t)dt + σ dW
// Approximated as       ΔX_t = θμ − θ X_t + ε      (OLS: y=ΔX, x=X_{t-1})
//   slope     = -θ  →  θ = -slope
//   intercept = θμ  →  μ = intercept / θ
//   σ         = std of residuals (per-bar shock).

export interface OuFit {
  /** Mean-reversion speed (per bar). Positive for a mean-reverting series. */
  theta: number;
  /** Long-run mean of the process. */
  mu: number;
  /** Per-bar shock standard deviation (volatility of innovations). */
  sigma: number;
}

export interface BertramThresholds {
  /** Distance above |spread - mu| at which to OPEN a position. */
  entry: number;
  /** Distance below |spread - mu| at which to CLOSE a position (smaller than entry). */
  exit: number;
}

export function ouFit(spread: number[]): OuFit {
  const n = spread.length;
  if (n < 3) throw new Error('ouFit: need at least 3 observations');

  const lagged = new Array<number>(n - 1);
  const diffs = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) {
    lagged[i - 1] = spread[i - 1];
    diffs[i - 1] = spread[i] - spread[i - 1];
  }
  const { a, b, residuals } = ols(lagged, diffs);
  const theta = -b;
  const mu = theta !== 0 ? a / theta : 0;

  let ssr = 0;
  for (let i = 0; i < residuals.length; i++) ssr += residuals[i] * residuals[i];
  const sigma = Math.sqrt(ssr / Math.max(1, residuals.length - 2));

  return { theta, mu, sigma };
}

/**
 * Optimal entry/exit thresholds for a mean-reverting OU spread, as distances
 * from μ. The strategy opens when |spread − μ| > entry and closes when
 * |spread − μ| < exit. This is the simplified Bertram (2010) form: higher
 * transaction costs widen the entry band.
 */
export function bertramThresholds(fit: OuFit, txCostFraction: number): BertramThresholds {
  if (fit.theta <= 0) {
    throw new Error('bertramThresholds: theta must be > 0 (series must be mean-reverting)');
  }
  if (txCostFraction < 0) {
    throw new Error('bertramThresholds: txCostFraction must be >= 0');
  }
  const sigmaEq = fit.sigma / Math.sqrt(2 * fit.theta);
  // Monotonically growing scale factor; ≈1.0 at zero cost, grows with √cost.
  const k = 1.0 + Math.sqrt(txCostFraction * 100);
  return {
    entry: k * sigmaEq,
    exit: 0.25 * sigmaEq,
  };
}
