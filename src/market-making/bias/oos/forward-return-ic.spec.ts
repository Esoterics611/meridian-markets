import {
  pearson,
  spearman,
  buildSignalForwardPairs,
  directionPnls,
  computeIc,
  oosForwardReturnIc,
  verdictFor,
  biasMagnitudeCap,
  SignalForwardPair,
} from './forward-return-ic';

// A seeded LCG so the "noise" fixtures are deterministic (no flaky CI).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('pearson / spearman', () => {
  it('pearson is +1 for a perfect linear relation, −1 for inverse', () => {
    const x = [1, 2, 3, 4, 5];
    expect(pearson(x, [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
    expect(pearson(x, [10, 8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });

  it('spearman is +1 for any monotone (non-linear) relation', () => {
    const x = [1, 2, 3, 4, 5];
    expect(spearman(x, [1, 4, 9, 16, 25])).toBeCloseTo(1, 6); // monotone but not linear
    expect(pearson(x, [1, 4, 9, 16, 25])).toBeLessThan(1); // pearson < 1 on the curve
  });

  it('returns 0 on a degenerate (constant) series', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
    expect(spearman([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('buildSignalForwardPairs', () => {
  const prices = [100, 110, 121, 133.1, 146.41]; // +10%/bar compounding
  it('uses data up to t only and log forward return at the horizon', () => {
    const signals = [1, 1, 1, 1, 1];
    const pairs = buildSignalForwardPairs(prices, signals, 1);
    expect(pairs).toHaveLength(4); // last bar has no forward
    expect(pairs[0].forwardReturn).toBeCloseTo(Math.log(110 / 100), 9);
    expect(pairs[3].forwardReturn).toBeCloseTo(Math.log(146.41 / 133.1), 9);
  });

  it('drops zero-signal observations by default (no view ⇒ not a trade)', () => {
    const signals = [0, 1, 0, 1, 1];
    const pairs = buildSignalForwardPairs(prices, signals, 1);
    expect(pairs).toHaveLength(2); // indices 1 and 3 survive (index 4 has no forward)
  });

  it('keeps zero-signal observations when asked', () => {
    const signals = [0, 0, 0, 0, 0];
    expect(buildSignalForwardPairs(prices, signals, 1, { dropZeroSignal: false })).toHaveLength(4);
  });
});

describe('directionPnls + computeIc', () => {
  it('a sign-perfect binary signal has hitRate 1, positive IC + mean P&L', () => {
    // signal sign always equals the forward-move sign (binary ±1 ⇒ Spearman<1 by ties).
    const pairs: SignalForwardPair[] = [
      { signal: 1, forwardReturn: 0.02 },
      { signal: -1, forwardReturn: -0.03 },
      { signal: 1, forwardReturn: 0.01 },
      { signal: -1, forwardReturn: -0.02 },
    ];
    const ic = computeIc(pairs);
    expect(ic.spearmanIc).toBeGreaterThan(0.5); // ties cap it below +1
    expect(ic.hitRate).toBe(1);
    expect(ic.meanDirectionPnl).toBeGreaterThan(0);
    expect(directionPnls(pairs).every((p) => p > 0)).toBe(true);
  });

  it('a continuous monotone signal reaches Spearman IC = +1', () => {
    const pairs: SignalForwardPair[] = [
      { signal: -2, forwardReturn: -0.03 },
      { signal: -1, forwardReturn: -0.01 },
      { signal: 0.5, forwardReturn: 0.005 },
      { signal: 1.5, forwardReturn: 0.02 },
      { signal: 3, forwardReturn: 0.04 },
    ];
    expect(computeIc(pairs).spearmanIc).toBeCloseTo(1, 6);
  });

  it('an anti-predictive signal has negative IC, hitRate 0, negative mean P&L', () => {
    const pairs: SignalForwardPair[] = [
      { signal: 1, forwardReturn: -0.02 },
      { signal: -1, forwardReturn: 0.03 },
      { signal: 1, forwardReturn: -0.01 },
      { signal: -1, forwardReturn: 0.02 },
    ];
    const ic = computeIc(pairs);
    expect(ic.spearmanIc).toBeLessThan(0);
    expect(ic.hitRate).toBe(0);
    expect(ic.meanDirectionPnl).toBeLessThan(0);
  });
});

describe('oosForwardReturnIc — purged k-fold + deflation', () => {
  // Build a long series where the signal genuinely predicts the next-bar return,
  // plus bounded noise, so the OOS IC is positive but not a degenerate +1.
  function predictivePairs(n: number, seed: number, edge: number): SignalForwardPair[] {
    const rnd = lcg(seed);
    const out: SignalForwardPair[] = [];
    for (let i = 0; i < n; i++) {
      const s = rnd() < 0.5 ? -1 : 1;
      // forward return = edge·sign + noise; edge>0 ⇒ signal predicts.
      const noise = (rnd() - 0.5) * 0.04;
      out.push({ signal: s, forwardReturn: edge * s + noise });
    }
    return out;
  }

  it('a real edge yields a positive OOS IC and a high deflated Sharpe', () => {
    const pairs = predictivePairs(400, 7, 0.01);
    const r = oosForwardReturnIc(pairs, 1, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    expect(r.n).toBe(400); // every obs is tested exactly once
    expect(r.spearmanIc).toBeGreaterThan(0);
    expect(r.meanDirectionPnl).toBeGreaterThan(0);
    expect(r.deflated.psr).toBeGreaterThan(0.9);
    expect(verdictFor(r)).toBe('VALIDATED');
  });

  it('pure noise does NOT validate (deflated Sharpe stays low)', () => {
    const rnd = lcg(99);
    const pairs: SignalForwardPair[] = [];
    for (let i = 0; i < 400; i++) {
      pairs.push({ signal: rnd() < 0.5 ? -1 : 1, forwardReturn: (rnd() - 0.5) * 0.04 });
    }
    const r = oosForwardReturnIc(pairs, 1, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    expect(Math.abs(r.spearmanIc)).toBeLessThan(0.15);
    expect(verdictFor(r)).not.toBe('VALIDATED');
  });

  it('the selection-bias haircut (trials, σ_SR) lowers the deflated Sharpe', () => {
    const pairs = predictivePairs(400, 11, 0.006);
    const noHaircut = oosForwardReturnIc(pairs, 1, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    const withHaircut = oosForwardReturnIc(pairs, 1, { folds: 5, embargoFrac: 0.01, trials: 40, sigmaSR: 0.5 });
    expect(withHaircut.deflated.expectedMaxSharpe).toBeGreaterThan(0);
    expect(withHaircut.deflated.dsr).toBeLessThanOrEqual(noHaircut.deflated.dsr);
  });

  it('INSUFFICIENT when there are too few observations', () => {
    const r = oosForwardReturnIc(predictivePairs(10, 3, 0.01), 1, { folds: 5, embargoFrac: 0.01, trials: 1, sigmaSR: 0 });
    expect(verdictFor(r, { minObs: 30 })).toBe('INSUFFICIENT');
  });
});

describe('verdictFor', () => {
  const base = {
    pearsonIc: 0,
    spearmanIc: 0,
    hitRate: 0.5,
    meanDirectionPnl: 0,
    stats: { sharpe: 0, skew: 0, kurtosis: 3, n: 100 },
    deflated: { psr: 0.5, expectedMaxSharpe: 0, dsr: 0.5, trials: 1, sigmaSR: 0 },
    n: 100,
    foldSpearmanIc: [],
  };

  it('NOT_VALIDATED when the mean edge is negative even with a high DSR', () => {
    const r = { ...base, meanDirectionPnl: -0.001, spearmanIc: -0.2, deflated: { ...base.deflated, dsr: 0.99 } };
    expect(verdictFor(r)).toBe('NOT_VALIDATED');
  });

  it('VALIDATED when edge positive AND DSR clears the bar', () => {
    const r = { ...base, meanDirectionPnl: 0.001, spearmanIc: 0.1, deflated: { ...base.deflated, dsr: 0.97, psr: 0.99 } };
    expect(verdictFor(r)).toBe('VALIDATED');
  });

  it('INCONCLUSIVE when edge positive, PSR ok, but DSR short of the bar', () => {
    const r = { ...base, meanDirectionPnl: 0.001, spearmanIc: 0.1, deflated: { ...base.deflated, dsr: 0.7, psr: 0.95 } };
    expect(verdictFor(r)).toBe('INCONCLUSIVE');
  });
});

describe('biasMagnitudeCap', () => {
  it('scales with |IC| and clamps at the hard cap', () => {
    expect(biasMagnitudeCap(0.05)).toBeCloseTo(0.2, 9); // 4·0.05
    expect(biasMagnitudeCap(0.5)).toBe(0.5); // clamped to hardCap
    expect(biasMagnitudeCap(0)).toBe(0);
    expect(biasMagnitudeCap(-0.1)).toBeCloseTo(0.4, 9); // sign-agnostic magnitude
  });
});
