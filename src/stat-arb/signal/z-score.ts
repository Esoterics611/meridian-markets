// Rolling and EWMA z-scores. Both consume a number[] and return a same-length
// number[]; insufficient-data positions are filled with NaN so callers can
// .filter(Number.isFinite) without losing index alignment.

export function rollingZScore(series: number[], lookback: number): number[] {
  if (!Number.isInteger(lookback) || lookback < 2) {
    throw new Error('rollingZScore: lookback must be an integer >= 2');
  }
  const n = series.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i < lookback - 1) {
      out[i] = NaN;
      continue;
    }
    let sum = 0;
    for (let j = i - lookback + 1; j <= i; j++) sum += series[j];
    const mean = sum / lookback;
    let sq = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      const d = series[j] - mean;
      sq += d * d;
    }
    const std = Math.sqrt(sq / lookback);
    out[i] = std > 0 ? (series[i] - mean) / std : 0;
  }
  return out;
}

/**
 * EWMA z-score. `lambda` is the decay factor in (0,1) — closer to 1 means
 * slower decay / longer memory. Convention:
 *   mu_t   = lambda * mu_{t-1}   + (1-lambda) * x_t
 *   var_t  = lambda * var_{t-1}  + (1-lambda) * (x_t - mu_{t-1})^2
 */
export function ewmaZScore(series: number[], lambda: number): number[] {
  if (!(lambda > 0 && lambda < 1)) {
    throw new Error('ewmaZScore: lambda must be in (0, 1)');
  }
  const n = series.length;
  if (n === 0) return [];

  const out = new Array<number>(n);
  let mu = series[0];
  let varEst = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const x = series[i];
    const dev = x - mu;
    varEst = lambda * varEst + (1 - lambda) * dev * dev;
    mu = lambda * mu + (1 - lambda) * x;
    const std = Math.sqrt(varEst);
    out[i] = std > 0 ? (x - mu) / std : 0;
  }
  return out;
}
