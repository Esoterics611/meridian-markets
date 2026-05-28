// Shared OLS primitive used by both cointegration (Engle-Granger first stage)
// and the OU fit. No external math library — closed-form normal equations.

export interface OlsResult {
  /** intercept */
  a: number;
  /** slope */
  b: number;
  /** residuals y - (a + b*x), one per observation */
  residuals: number[];
}

export interface OlsResultWithStats extends OlsResult {
  /** t-statistic of the slope b (b / se(b)) — used for the ADF test */
  tStatB: number;
}

/**
 * Ordinary least squares for the model y = a + b * x.
 * Throws if lengths differ, n < 2, or x has zero variance.
 */
export function ols(x: number[], y: number[]): OlsResult {
  if (x.length !== y.length) throw new Error('ols: x and y must have same length');
  const n = x.length;
  if (n < 2) throw new Error('ols: need at least 2 observations');

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    num += dx * (y[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) throw new Error('ols: x has zero variance');

  const b = num / den;
  const a = meanY - b * meanX;

  const residuals = new Array<number>(n);
  for (let i = 0; i < n; i++) residuals[i] = y[i] - (a + b * x[i]);

  return { a, b, residuals };
}

/** OLS plus the slope t-statistic — needed for the ADF unit-root test. */
export function olsWithStats(x: number[], y: number[]): OlsResultWithStats {
  const { a, b, residuals } = ols(x, y);
  const n = x.length;

  let ssr = 0;
  for (let i = 0; i < n; i++) ssr += residuals[i] * residuals[i];
  const sigma2 = n > 2 ? ssr / (n - 2) : ssr / Math.max(1, n - 1);

  let meanX = 0;
  for (let i = 0; i < n; i++) meanX += x[i];
  meanX /= n;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    sxx += dx * dx;
  }
  const seB = sxx > 0 ? Math.sqrt(sigma2 / sxx) : Infinity;
  const tStatB = seB > 0 && Number.isFinite(seB) ? b / seB : 0;

  return { a, b, residuals, tStatB };
}
