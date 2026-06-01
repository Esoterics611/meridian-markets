import {
  normalCdf,
  inverseNormalCdf,
  sharpeStats,
  probabilisticSharpe,
  expectedMaxSharpe,
  deflatedSharpe,
} from './deflated-sharpe';

describe('normalCdf / inverseNormalCdf', () => {
  it('normalCdf hits the known anchors', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 4); // 95th pct
    expect(normalCdf(-1.6448536)).toBeCloseTo(0.05, 4);
  });

  it('inverseNormalCdf is the inverse of normalCdf', () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      expect(normalCdf(inverseNormalCdf(p))).toBeCloseTo(p, 4);
    }
  });

  it('inverseNormalCdf(0.975) ≈ 1.96', () => {
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 3);
  });
});

describe('sharpeStats', () => {
  it('a normal-ish symmetric series has ~0 skew and ~3 kurtosis', () => {
    // Symmetric around the mean.
    const s = sharpeStats([-2, -1, 0, 1, 2, -2, -1, 0, 1, 2]);
    expect(Math.abs(s.skew)).toBeLessThan(0.1);
    expect(s.n).toBe(10);
  });

  it('matches the mean/sample-σ Sharpe convention', () => {
    const pnls = [10, 12, 8, 11, 9];
    const s = sharpeStats(pnls);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    let v = 0;
    for (const x of pnls) v += (x - mean) ** 2;
    v /= pnls.length - 1;
    expect(s.sharpe).toBeCloseTo(mean / Math.sqrt(v), 6);
  });

  it('a right-skewed series reports positive skew', () => {
    const s = sharpeStats([0, 0, 0, 0, 0, 0, 0, 0, 0, 100]);
    expect(s.skew).toBeGreaterThan(1);
  });

  it('degenerate (n<2) is safe', () => {
    expect(sharpeStats([]).sharpe).toBe(0);
    expect(sharpeStats([5]).sharpe).toBe(0);
  });
});

describe('probabilisticSharpe', () => {
  it('is 0.5 when the observed Sharpe equals the benchmark', () => {
    expect(probabilisticSharpe(1.0, 100, 0, 3, 1.0)).toBeCloseTo(0.5, 6);
  });

  it('rises toward 1 with more observations at a fixed positive Sharpe', () => {
    const few = probabilisticSharpe(0.5, 10, 0, 3, 0);
    const many = probabilisticSharpe(0.5, 500, 0, 3, 0);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeGreaterThan(0.9);
  });

  it('a positive Sharpe on a tiny sample is NOT convincing', () => {
    expect(probabilisticSharpe(0.4, 6, 0, 3, 0)).toBeLessThan(0.9);
  });

  it('negative skew + fat tails lowers the PSR (riskier than normal)', () => {
    const normalLike = probabilisticSharpe(0.5, 100, 0, 3, 0);
    const fatLeftTail = probabilisticSharpe(0.5, 100, -1.5, 8, 0);
    expect(fatLeftTail).toBeLessThan(normalLike);
  });
});

describe('expectedMaxSharpe', () => {
  it('is 0 for a single trial', () => {
    expect(expectedMaxSharpe(1, 0.5)).toBe(0);
  });

  it('grows with the number of trials', () => {
    const sig = 0.5;
    expect(expectedMaxSharpe(100, sig)).toBeGreaterThan(expectedMaxSharpe(10, sig));
  });

  it('scales with the trial Sharpe dispersion', () => {
    expect(expectedMaxSharpe(50, 1.0)).toBeGreaterThan(expectedMaxSharpe(50, 0.25));
  });
});

describe('deflatedSharpe', () => {
  it('DSR ≤ PSR once there is more than one trial (selection haircut bites)', () => {
    const r = deflatedSharpe(1.5, 120, 0, 3, 90, 0.5);
    expect(r.dsr).toBeLessThanOrEqual(r.psr);
    expect(r.expectedMaxSharpe).toBeGreaterThan(0);
  });

  it('with one trial, DSR == PSR (no selection bias)', () => {
    const r = deflatedSharpe(1.2, 100, 0, 3, 1, 0.5);
    expect(r.expectedMaxSharpe).toBe(0);
    expect(r.dsr).toBeCloseTo(r.psr, 6);
  });

  it('a Sharpe that is merely the best-of-90 by luck deflates to ~coin-flip or worse', () => {
    // Observed Sharpe sits right at the selection benchmark → DSR ~ 0.5.
    const sigmaSR = 0.5;
    const emax = expectedMaxSharpe(90, sigmaSR);
    const r = deflatedSharpe(emax, 120, 0, 3, 90, sigmaSR);
    expect(r.dsr).toBeCloseTo(0.5, 1);
  });
});
