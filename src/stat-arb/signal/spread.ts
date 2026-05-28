/**
 * Log-price spread S_t = log(A_t) − β * log(B_t).
 * β is the hedge ratio from a cointegration test on the same series.
 */
export function logSpread(pricesA: number[], pricesB: number[], beta: number): number[] {
  if (pricesA.length !== pricesB.length) {
    throw new Error('logSpread: pricesA and pricesB must have same length');
  }
  const n = pricesA.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.log(pricesA[i]) - beta * Math.log(pricesB[i]);
  }
  return out;
}
