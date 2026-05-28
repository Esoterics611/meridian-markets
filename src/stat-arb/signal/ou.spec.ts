import { ouFit, bertramThresholds } from './ou';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function simulateOu(theta: number, mu: number, sigma: number, n: number, seed: number): number[] {
  const r = rng(seed);
  const out = new Array<number>(n);
  out[0] = mu;
  for (let i = 1; i < n; i++) {
    out[i] = out[i - 1] + theta * (mu - out[i - 1]) + sigma * gauss(r);
  }
  return out;
}

describe('ouFit', () => {
  it('recovers theta within tolerance from a simulated OU process', () => {
    const series = simulateOu(0.1, 0.0, 0.05, 2000, 13);
    const fit = ouFit(series);
    expect(fit.theta).toBeGreaterThan(0.05);
    expect(fit.theta).toBeLessThan(0.2);
  });

  it('recovers mu within tolerance from a simulated OU process', () => {
    const series = simulateOu(0.2, 1.5, 0.05, 2000, 21);
    const fit = ouFit(series);
    expect(fit.mu).toBeCloseTo(1.5, 0);
  });

  it('reports a positive sigma on a noisy OU series', () => {
    const series = simulateOu(0.2, 0.0, 0.05, 500, 7);
    const fit = ouFit(series);
    expect(fit.sigma).toBeGreaterThan(0);
  });

  it('throws on fewer than 3 observations', () => {
    expect(() => ouFit([1, 2])).toThrow(/at least 3/);
  });
});

describe('bertramThresholds', () => {
  it('returns entry > exit (not inverted)', () => {
    const t = bertramThresholds({ theta: 0.1, mu: 0, sigma: 0.05 }, 0.001);
    expect(t.entry).toBeGreaterThan(t.exit);
  });

  it('throws when theta is not positive', () => {
    expect(() => bertramThresholds({ theta: 0, mu: 0, sigma: 0.05 }, 0)).toThrow(/theta/);
    expect(() => bertramThresholds({ theta: -0.1, mu: 0, sigma: 0.05 }, 0)).toThrow(/theta/);
  });

  it('entry widens monotonically with transaction cost', () => {
    const fit = { theta: 0.1, mu: 0, sigma: 0.05 };
    const low = bertramThresholds(fit, 0);
    const mid = bertramThresholds(fit, 0.001);
    const high = bertramThresholds(fit, 0.01);
    expect(low.entry).toBeLessThanOrEqual(mid.entry);
    expect(mid.entry).toBeLessThan(high.entry);
  });
});
