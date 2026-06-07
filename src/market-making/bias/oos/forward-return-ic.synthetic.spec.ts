// End-to-end (offline) demonstration of the directional-bias OOS pipeline the
// scripts/directional-bias-oos.ts sweep runs on REAL data. This builds a synthetic
// price + funding series with a KNOWN structure and confirms the gate returns the
// right verdict — so the sweep's wiring is exercised without network. The numbers
// here are SYNTHETIC by construction (a planted edge), not a market read.

import {
  buildSignalForwardPairs,
  oosForwardReturnIc,
  verdictFor,
} from './forward-return-ic';

// Mirror the two trailing, no-look-ahead signal builders from the sweep so the
// spec exercises the same construction (kept local — the script's helpers are
// private to the runnable).
function trailingMomentum(prices: number[], lookback: number): number[] {
  const out = new Array(prices.length).fill(NaN);
  for (let i = lookback; i < prices.length; i++) out[i] = Math.log(prices[i] / prices[i - lookback]);
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0), s / 4294967296);
}

describe('directional-bias OOS pipeline (offline synthetic)', () => {
  it('a trending series validates the momentum bias; a mean-reverting one does not', () => {
    const n = 600;
    const lookback = 24;
    const horizon = 24;

    // Trending price: persistent drift segments ⇒ trailing return predicts forward.
    const rndT = lcg(5);
    const trend: number[] = [100];
    let driftT = 0.0015;
    for (let i = 1; i < n; i++) {
      if (i % 60 === 0) driftT = (rndT() < 0.5 ? -1 : 1) * 0.0015; // regime flip
      trend.push(trend[i - 1] * Math.exp(driftT + (rndT() - 0.5) * 0.004));
    }
    const momT = trailingMomentum(trend, lookback);
    const pairsT = buildSignalForwardPairs(trend, momT, horizon);
    const repT = oosForwardReturnIc(pairsT, horizon, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    expect(repT.spearmanIc).toBeGreaterThan(0);
    expect(repT.meanDirectionPnl).toBeGreaterThan(0);
    expect(verdictFor(repT)).toBe('VALIDATED');

    // Mean-reverting price: trailing return predicts AGAINST forward ⇒ momentum fails.
    const rndR = lcg(9);
    const rev: number[] = [100];
    for (let i = 1; i < n; i++) {
      const pull = -0.3 * (Math.log(rev[i - 1] / 100)); // revert to 100
      rev.push(rev[i - 1] * Math.exp(pull + (rndR() - 0.5) * 0.01));
    }
    const momR = trailingMomentum(rev, lookback);
    const pairsR = buildSignalForwardPairs(rev, momR, horizon);
    const repR = oosForwardReturnIc(pairsR, horizon, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    expect(verdictFor(repR)).not.toBe('VALIDATED');
  });

  it('a funding sign uncorrelated with forward return does NOT validate', () => {
    const n = 500;
    const horizon = 24;
    const rnd = lcg(3);
    // Random-walk price independent of the funding sign series.
    const prices: number[] = [100];
    for (let i = 1; i < n; i++) prices.push(prices[i - 1] * Math.exp((rnd() - 0.5) * 0.01));
    // bias = −trailing funding; funding sign is random (no relation to price).
    const biasSig = new Array(n).fill(0).map(() => (rnd() < 0.5 ? -1 : 1) * 0.00001);
    const pairs = buildSignalForwardPairs(prices, biasSig, horizon);
    const rep = oosForwardReturnIc(pairs, horizon, { folds: 5, embargoFrac: 0.01, trials: 36, sigmaSR: 0.4 });
    expect(verdictFor(rep)).not.toBe('VALIDATED');
  });
});
