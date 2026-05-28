import { halfKellyNotional, kellyFraction, HALF_KELLY } from './kelly';

describe('kellyFraction', () => {
  it('returns 0 for non-positive edge', () => {
    expect(kellyFraction(0, 0.01)).toBe(0);
    expect(kellyFraction(-0.01, 0.01)).toBe(0);
  });

  it('returns 0 for non-positive variance', () => {
    expect(kellyFraction(0.01, 0)).toBe(0);
    expect(kellyFraction(0.01, -0.01)).toBe(0);
  });

  it('returns edge / variance when both positive', () => {
    expect(kellyFraction(0.05, 0.5)).toBeCloseTo(0.1);
  });

  it('clamps the fraction to 1', () => {
    expect(kellyFraction(10, 0.5)).toBe(1);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(kellyFraction(NaN, 0.5)).toBe(0);
    expect(kellyFraction(0.01, Infinity)).toBe(0);
  });
});

describe('halfKellyNotional', () => {
  it('returns 0n on zero capital', () => {
    expect(halfKellyNotional(0n, 0.05, 0.5)).toBe(0n);
  });

  it('returns 0n on zero edge', () => {
    expect(halfKellyNotional(1_000_000n, 0, 0.5)).toBe(0n);
  });

  it('scales linearly with capital', () => {
    const a = halfKellyNotional(1_000_000n, 0.05, 0.5);
    const b = halfKellyNotional(2_000_000n, 0.05, 0.5);
    expect(b).toBe(a * 2n);
  });

  it('applies the HALF_KELLY shrinkage', () => {
    const full = kellyFraction(0.05, 0.5); // = 0.1
    const sized = halfKellyNotional(10_000_000n, 0.05, 0.5);
    expect(Number(sized)).toBeCloseTo(10_000_000 * full * HALF_KELLY, -3);
  });

  it('shrinks for higher variance', () => {
    const small = halfKellyNotional(1_000_000n, 0.05, 0.1);
    const big = halfKellyNotional(1_000_000n, 0.05, 1.0);
    expect(small).toBeGreaterThan(big);
  });

  it('returns 0n for non-positive volMultiplier', () => {
    expect(halfKellyNotional(1_000_000n, 0.05, 0.5, 0)).toBe(0n);
    expect(halfKellyNotional(1_000_000n, 0.05, 0.5, -1)).toBe(0n);
  });

  it('respects the f <= 1 clamp via the inner kellyFraction', () => {
    const r = halfKellyNotional(1_000_000n, 100, 0.001);
    expect(r).toBeLessThanOrEqual(1_000_000n);
    expect(r).toBeGreaterThan(0n);
  });
});
