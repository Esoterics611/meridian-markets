import { ols, olsWithStats } from './_math';

describe('ols', () => {
  it('recovers slope and intercept on a perfect line y = 2x', () => {
    const { a, b, residuals } = ols([1, 2, 3, 4], [2, 4, 6, 8]);
    expect(a).toBeCloseTo(0, 10);
    expect(b).toBeCloseTo(2, 10);
    for (const r of residuals) expect(Math.abs(r)).toBeLessThan(1e-10);
  });

  it('recovers slope and intercept on y = 3 + 0.5x', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const y = x.map((v) => 3 + 0.5 * v);
    const { a, b } = ols(x, y);
    expect(a).toBeCloseTo(3, 10);
    expect(b).toBeCloseTo(0.5, 10);
  });

  it('throws when lengths differ', () => {
    expect(() => ols([1, 2], [1])).toThrow(/same length/);
  });

  it('throws when x has zero variance', () => {
    expect(() => ols([1, 1, 1], [2, 3, 4])).toThrow(/zero variance/);
  });

  it('olsWithStats returns a finite t-statistic on a strong relationship', () => {
    const x = Array.from({ length: 50 }, (_, i) => i);
    const y = x.map((v) => 1 + 2 * v + (v % 2 === 0 ? 0.001 : -0.001));
    const { tStatB } = olsWithStats(x, y);
    expect(Number.isFinite(tStatB)).toBe(true);
    expect(tStatB).toBeGreaterThan(100);
  });
});
