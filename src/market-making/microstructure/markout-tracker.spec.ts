import { MarkoutTracker } from './markout-tracker';

const MICROS = 1_000_000n;
const px = (p: number) => BigInt(Math.round(p * Number(MICROS)));

describe('MarkoutTracker', () => {
  it('is empty until a fill resolves a horizon', () => {
    const t = new MarkoutTracker([1000, 5000]);
    expect(t.curve()).toEqual([
      { ms: 1000, bps: null, count: 0 },
      { ms: 5000, bps: null, count: 0 },
    ]);
    t.onFill('BUY', px(100), 0);
    t.onMid(500, px(101)); // age 500ms < 1000ms — not yet
    expect(t.curve()[0].count).toBe(0);
  });

  it('marks a BUY favorably when the mid rises (positive bps)', () => {
    const t = new MarkoutTracker([1000]);
    t.onFill('BUY', px(100), 0);
    t.onMid(1000, px(101)); // +1% = +100 bps in our favor (we were long)
    const c = t.curve()[0];
    expect(c.count).toBe(1);
    expect(c.bps).toBeCloseTo(100, 6);
  });

  it('marks a BUY adversely when the mid falls (negative bps = picked off)', () => {
    const t = new MarkoutTracker([1000]);
    t.onFill('BUY', px(100), 0);
    t.onMid(1200, px(99)); // −1% against a long
    expect(t.curve()[0].bps).toBeCloseTo(-100, 6);
  });

  it('flips the sign for a SELL (short profits when the mid falls)', () => {
    const t = new MarkoutTracker([1000]);
    t.onFill('SELL', px(100), 0);
    t.onMid(1000, px(99)); // mid fell → good for a short → positive
    expect(t.curve()[0].bps).toBeCloseTo(100, 6);
  });

  it('resolves multiple horizons, catching up past skipped ones with the available mid', () => {
    const t = new MarkoutTracker([1000, 5000]);
    t.onFill('BUY', px(100), 0);
    // First mid arrives only at 6s — both horizons resolve against this print.
    t.onMid(6000, px(102));
    const c = t.curve();
    expect(c[0].count).toBe(1);
    expect(c[1].count).toBe(1);
    expect(c[0].bps).toBeCloseTo(200, 6);
    expect(c[1].bps).toBeCloseTo(200, 6);
  });

  it('averages across fills per horizon', () => {
    const t = new MarkoutTracker([1000]);
    t.onFill('BUY', px(100), 0); // +100 bps
    t.onFill('BUY', px(100), 0); // −100 bps via a later, different mark
    t.onMid(1000, px(101)); // resolves BOTH at +100
    expect(t.curve()[0].bps).toBeCloseTo(100, 6);
    expect(t.curve()[0].count).toBe(2);
  });

  it('sorts + dedupes horizons and ignores non-positive ones', () => {
    const t = new MarkoutTracker([5000, 1000, 1000, -10, 0]);
    expect(t.curve().map((p) => p.ms)).toEqual([1000, 5000]);
  });
});
