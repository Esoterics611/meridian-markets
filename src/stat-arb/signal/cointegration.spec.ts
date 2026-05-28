import { cointegrationTest } from './cointegration';

// Deterministic RNG so the random-walk specs do not flake. Mulberry32.
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

function gauss(rand: () => number): number {
  // Box-Muller
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe('cointegrationTest', () => {
  it('recovers beta ≈ 1 when logA = logB + stationary noise', () => {
    const r = rng(42);
    const logB: number[] = [];
    let b = 0;
    for (let i = 0; i < 400; i++) {
      b += 0.01 * gauss(r); // logB is a random walk
      logB.push(b);
    }
    const logA = logB.map((v) => v + 0.05 * gauss(r)); // logA = logB + IID noise
    const { beta, pValue } = cointegrationTest(logA, logB);
    expect(beta).toBeGreaterThan(0.8);
    expect(beta).toBeLessThan(1.2);
    expect(pValue).toBeLessThan(0.1);
  });

  it('reports a stationary residual (low p-value) for cointegrated series', () => {
    const r = rng(7);
    const logB: number[] = [];
    let b = 0;
    for (let i = 0; i < 400; i++) {
      b += 0.01 * gauss(r);
      logB.push(b);
    }
    const logA = logB.map((v, i) => 2 * v + 1 + 0.02 * gauss(rng(i + 1)));
    const { beta, pValue } = cointegrationTest(logA, logB);
    expect(beta).toBeGreaterThan(1.7);
    expect(beta).toBeLessThan(2.3);
    expect(pValue).toBeLessThan(0.1);
  });

  it('reports a high p-value for two independent random walks', () => {
    const ra = rng(1001);
    const rb = rng(2002);
    const logA: number[] = [];
    const logB: number[] = [];
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      a += 0.01 * gauss(ra);
      b += 0.01 * gauss(rb);
      logA.push(a);
      logB.push(b);
    }
    const { pValue } = cointegrationTest(logA, logB);
    expect(pValue).toBeGreaterThan(0.05);
  });

  it('returns a finite positive half-life for a strongly mean-reverting residual', () => {
    const r = rng(99);
    const logB: number[] = [];
    let b = 0;
    for (let i = 0; i < 400; i++) {
      b += 0.01 * gauss(r);
      logB.push(b);
    }
    const logA = logB.map((v) => v + 0.05 * gauss(r));
    const { halfLifeBars } = cointegrationTest(logA, logB);
    expect(Number.isFinite(halfLifeBars)).toBe(true);
    expect(halfLifeBars).toBeGreaterThan(0);
    expect(halfLifeBars).toBeLessThan(100);
  });

  it('throws when input lengths differ', () => {
    expect(() => cointegrationTest([1, 2, 3], [1, 2])).toThrow(/same length/);
  });

  it('throws when too few observations', () => {
    expect(() => cointegrationTest([1, 2], [3, 4])).toThrow(/at least 10/);
  });
});
