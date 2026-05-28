import { slidingCointegration, latestAsOf } from './sliding-cointegration';

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
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function cointegratedPair(n: number, beta: number, seed: number): { a: number[]; b: number[] } {
  const r = rng(seed);
  const b: number[] = [];
  let bv = 0;
  for (let i = 0; i < n; i++) {
    bv += 0.01 * gauss(r);
    b.push(bv);
  }
  const a = b.map((v) => beta * v + 0.05 * gauss(r));
  return { a, b };
}

describe('slidingCointegration', () => {
  it('produces one fit per refitEveryBars step', () => {
    const { a, b } = cointegratedPair(200, 1, 42);
    const fits = slidingCointegration(a, b, 60, 20);
    // first fit at index 59, then 79, 99, 119, 139, 159, 179, 199
    expect(fits.length).toBe(8);
    expect(fits[0].fittedAtIndex).toBe(59);
    expect(fits[fits.length - 1].fittedAtIndex).toBe(199);
  });

  it('recovers approximately the true beta on each window', () => {
    const { a, b } = cointegratedPair(300, 2.0, 7);
    const fits = slidingCointegration(a, b, 80, 40);
    for (const f of fits) {
      expect(f.beta).toBeGreaterThan(1.4);
      expect(f.beta).toBeLessThan(2.6);
    }
  });

  it('reports lower p-values on cointegrated than on uncorrelated random walks', () => {
    const { a: a1, b: b1 } = cointegratedPair(250, 1, 11);
    const fits1 = slidingCointegration(a1, b1, 100, 50);
    const r1 = rng(101);
    const r2 = rng(202);
    const ra: number[] = [];
    const rb: number[] = [];
    let av = 0;
    let bv = 0;
    for (let i = 0; i < 250; i++) {
      av += 0.01 * gauss(r1);
      bv += 0.01 * gauss(r2);
      ra.push(av);
      rb.push(bv);
    }
    const fits2 = slidingCointegration(ra, rb, 100, 50);
    const avg1 = fits1.reduce((s, f) => s + f.pValue, 0) / fits1.length;
    const avg2 = fits2.reduce((s, f) => s + f.pValue, 0) / fits2.length;
    expect(avg1).toBeLessThan(avg2);
  });

  it('throws on length mismatch', () => {
    expect(() => slidingCointegration([1, 2, 3], [1, 2], 10, 5)).toThrow(/same length/);
  });

  it('throws when windowBars < 10', () => {
    expect(() => slidingCointegration([1, 2, 3], [1, 2, 3], 5, 1)).toThrow(/windowBars/);
  });

  it('throws when refitEveryBars < 1', () => {
    expect(() => slidingCointegration([1, 2, 3], [1, 2, 3], 10, 0)).toThrow(/refitEveryBars/);
  });

  it('returns no fits when the series is shorter than the window', () => {
    const { a, b } = cointegratedPair(40, 1, 1);
    const fits = slidingCointegration(a, b, 60, 10);
    expect(fits).toEqual([]);
  });

  it('latestAsOf returns the most recent fit at or before the asOf index', () => {
    const { a, b } = cointegratedPair(200, 1, 5);
    const fits = slidingCointegration(a, b, 50, 25);
    // fits at indices 49, 74, 99, 124, 149, 174, 199.
    expect(latestAsOf(fits, 30)).toBeNull();
    expect(latestAsOf(fits, 49)!.fittedAtIndex).toBe(49);
    expect(latestAsOf(fits, 100)!.fittedAtIndex).toBe(99);
    expect(latestAsOf(fits, 999)!.fittedAtIndex).toBe(199);
  });
});
