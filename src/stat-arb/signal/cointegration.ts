import { ols, olsWithStats } from './_math';

// Engle-Granger two-step cointegration test on log-price series.
//   Step 1: OLS regress logA on logB → hedge ratio beta and residual series.
//   Step 2: ADF unit-root test on the residuals via the AR(1) form
//             Δr_t = a + φ * r_{t-1} + ε
//           Rejecting φ = 0 in favour of φ < 0 means the residuals are
//           stationary, i.e. the original series are cointegrated.
//
// p-value uses the MacKinnon (1994) response-surface critical values,
// coarsely interpolated. Good enough for golden-vector tests and demo.

export interface CointegrationResult {
  /** Hedge ratio from step-1 OLS (logA ≈ alpha + beta*logB). */
  beta: number;
  /** Approximate p-value of the ADF test on residuals. */
  pValue: number;
  /** Half-life of mean reversion in bars: ln(2) / |phi|. Infinity if non-mean-reverting. */
  halfLifeBars: number;
}

export function cointegrationTest(logA: number[], logB: number[]): CointegrationResult {
  if (logA.length !== logB.length) {
    throw new Error('cointegrationTest: logA and logB must have same length');
  }
  if (logA.length < 10) {
    throw new Error('cointegrationTest: need at least 10 observations');
  }

  // Step 1 — Engle-Granger first stage.
  const { b: beta, residuals } = ols(logB, logA);

  // Step 2 — ADF on residuals: regress Δr on lagged r (with intercept).
  const n = residuals.length;
  const lagged = new Array<number>(n - 1);
  const diffs = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) {
    lagged[i - 1] = residuals[i - 1];
    diffs[i - 1] = residuals[i] - residuals[i - 1];
  }
  const { b: phi, tStatB } = olsWithStats(lagged, diffs);

  return {
    beta,
    pValue: adfPValue(tStatB),
    halfLifeBars: phi < 0 ? Math.log(2) / Math.abs(phi) : Number.POSITIVE_INFINITY,
  };
}

// MacKinnon (1994) approximate critical values for the Engle-Granger
// no-trend, two-variable case. Coarse but correct-directional.
function adfPValue(tStat: number): number {
  if (tStat < -3.9) return 0.005;
  if (tStat < -3.34) return 0.025;
  if (tStat < -3.04) return 0.075;
  return 0.5;
}
