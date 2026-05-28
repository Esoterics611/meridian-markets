import { detectGaps } from './gap-detector';

const minute = 60_000;
function ts(...mins: number[]): Date[] {
  return mins.map((m) => new Date(Date.UTC(2026, 0, 1, 0, m)));
}

describe('detectGaps', () => {
  it('returns an empty array for a contiguous series', () => {
    expect(detectGaps(ts(0, 1, 2, 3, 4), minute)).toEqual([]);
  });

  it('detects a single gap of N missing bars', () => {
    // 0,1,2,5 → gap of 2 missing bars between minute 2 and minute 5.
    const gaps = detectGaps(ts(0, 1, 2, 5), minute);
    expect(gaps.length).toBe(1);
    expect(gaps[0].missingBars).toBe(2);
    expect(gaps[0].gapStart.getUTCMinutes()).toBe(2);
    expect(gaps[0].gapEnd.getUTCMinutes()).toBe(5);
  });

  it('detects multiple gaps in the same series', () => {
    const gaps = detectGaps(ts(0, 3, 5, 10), minute);
    expect(gaps.length).toBe(3);
  });

  it('treats exactly-on-interval gaps as no-gap (dt === expected)', () => {
    expect(detectGaps(ts(0, 1, 2), minute)).toEqual([]);
  });

  it('throws on non-positive expected interval', () => {
    expect(() => detectGaps(ts(0, 1), 0)).toThrow();
    expect(() => detectGaps(ts(0, 1), -1)).toThrow();
  });

  it('returns empty for fewer than 2 bars', () => {
    expect(detectGaps([], minute)).toEqual([]);
    expect(detectGaps(ts(0), minute)).toEqual([]);
  });
});
