import { rollingZScore, ewmaZScore } from './z-score';

describe('rollingZScore', () => {
  it('fills positions before the first full window with NaN', () => {
    const out = rollingZScore([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isFinite(out[2])).toBe(true);
  });

  it('computes z = (x - mean) / std for the last position in the window', () => {
    // Window [1,2,3]: mean=2, variance = ((1-2)^2 + 0 + (3-2)^2)/3 = 2/3, std ≈ 0.8165
    const out = rollingZScore([1, 2, 3], 3);
    const expected = (3 - 2) / Math.sqrt(2 / 3);
    expect(out[2]).toBeCloseTo(expected, 6);
  });

  it('returns 0 when the window is constant (std = 0)', () => {
    const out = rollingZScore([5, 5, 5, 5], 3);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(0);
  });

  it('handles series shorter than the lookback (all NaN)', () => {
    const out = rollingZScore([1, 2], 5);
    expect(out).toEqual([NaN, NaN]);
  });

  it('throws on invalid lookback', () => {
    expect(() => rollingZScore([1, 2, 3], 1)).toThrow();
    expect(() => rollingZScore([1, 2, 3], 1.5)).toThrow();
  });
});

describe('ewmaZScore', () => {
  it('returns empty for empty input', () => {
    expect(ewmaZScore([], 0.9)).toEqual([]);
  });

  it('first element is 0 (no variance yet)', () => {
    const out = ewmaZScore([10, 11, 12], 0.9);
    expect(out[0]).toBe(0);
  });

  it('returns finite numbers on a varying series', () => {
    const out = ewmaZScore([1, 2, 1, 2, 1, 2, 1, 2], 0.9);
    for (let i = 1; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('throws when lambda is out of (0,1)', () => {
    expect(() => ewmaZScore([1, 2, 3], 0)).toThrow();
    expect(() => ewmaZScore([1, 2, 3], 1)).toThrow();
    expect(() => ewmaZScore([1, 2, 3], 1.5)).toThrow();
  });
});
