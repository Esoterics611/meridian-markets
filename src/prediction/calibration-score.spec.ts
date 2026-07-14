import {
  bootstrapDiffCI,
  BrierContribution,
  brierSummary,
  CalibrationBook,
} from './calibration-score';

const H = 3_600_000;

describe('CalibrationBook', () => {
  it('freezes the FIRST observation past each horizon boundary (no cherry-picking)', () => {
    const book = new CalibrationBook([6, 3, 1]);
    const expiry = 100 * H;
    book.onSnap('m1', expiry, expiry - 7 * H, 0.7, 0.6); // 7h out — freezes nothing
    book.onSnap('m1', expiry, expiry - 5 * H, 0.71, 0.61); // first ≤6h → frozen for 6h
    book.onSnap('m1', expiry, expiry - 4 * H, 0.72, 0.62); // 6h already frozen — ignored
    book.onSnap('m1', expiry, expiry - 2 * H, 0.73, 0.63); // first ≤3h
    book.onSnap('m1', expiry, expiry - 0.5 * H, 0.74, 0.64); // first ≤1h
    const out = book.onSettle('m1', true);
    expect(out).toHaveLength(3);
    const byH = new Map(out.map((c) => [c.horizonH, c]));
    expect(byH.get(6)).toMatchObject({ fair: 0.71, mid: 0.61, y: 1 });
    expect(byH.get(3)).toMatchObject({ fair: 0.73, mid: 0.63, y: 1 });
    expect(byH.get(1)).toMatchObject({ fair: 0.74, mid: 0.64, y: 1 });
  });

  it('a market that never crossed a horizon contributes nothing; settle clears state', () => {
    const book = new CalibrationBook([1]);
    const expiry = 100 * H;
    book.onSnap('m1', expiry, expiry - 5 * H, 0.7, 0.6);
    expect(book.onSettle('m1', false)).toHaveLength(0);
    expect(book.onSettle('m1', false)).toHaveLength(0); // already settled — idempotent
    expect(book.all()).toHaveLength(0);
  });
});

describe('brierSummary', () => {
  it('computes Brier for fair and mid and the paired mean difference', () => {
    const contribs: BrierContribution[] = [
      { marketId: 'a', horizonH: 3, fair: 0.8, mid: 0.6, y: 1 },
      { marketId: 'b', horizonH: 3, fair: 0.2, mid: 0.4, y: 0 },
    ];
    const s = brierSummary(contribs);
    expect(s.n).toBe(2);
    expect(s.settles).toBe(2);
    expect(s.brierFair).toBeCloseTo((0.04 + 0.04) / 2, 10);
    expect(s.brierMid).toBeCloseTo((0.16 + 0.16) / 2, 10);
    expect(s.meanDiff).toBeCloseTo(0.12, 10); // positive ⇒ fair better calibrated
  });

  it('filters by horizon and handles empty input', () => {
    const contribs: BrierContribution[] = [
      { marketId: 'a', horizonH: 3, fair: 0.8, mid: 0.6, y: 1 },
      { marketId: 'a', horizonH: 1, fair: 0.9, mid: 0.7, y: 1 },
    ];
    expect(brierSummary(contribs, 1).n).toBe(1);
    expect(brierSummary([], 1).n).toBe(0);
  });
});

describe('bootstrapDiffCI', () => {
  const mkContribs = (n: number, fairErr: number, midErr: number): BrierContribution[] => {
    // Alternating outcomes; fair misses by fairErr, mid by midErr — fair wins iff smaller.
    const out: BrierContribution[] = [];
    for (let i = 0; i < n; i++) {
      const y = (i % 2) as 0 | 1;
      out.push({
        marketId: `m${i}`,
        horizonH: 3,
        fair: y === 1 ? 1 - fairErr : fairErr,
        mid: y === 1 ? 1 - midErr : midErr,
        y,
      });
    }
    return out;
  };

  it('a consistently better-calibrated fair clears zero at the 95% CI', () => {
    const ci = bootstrapDiffCI(mkContribs(30, 0.1, 0.3), 2_000);
    expect(ci.settles).toBe(30);
    expect(ci.meanDiff).toBeCloseTo(0.09 - 0.01, 10);
    expect(ci.lo95).toBeGreaterThan(0);
  });

  it('is deterministic under a fixed seed and resamples settles, not rows', () => {
    const contribs = [
      ...mkContribs(20, 0.2, 0.25),
      // Second horizon rows for the same settles — must move WITH their settle.
      ...mkContribs(20, 0.2, 0.25).map((c) => ({ ...c, horizonH: 1 })),
    ];
    const a = bootstrapDiffCI(contribs, 2_000, 42);
    const b = bootstrapDiffCI(contribs, 2_000, 42);
    expect(a).toEqual(b);
    expect(a.settles).toBe(20); // 40 rows, 20 settles
  });

  it('refuses a CI below two settles', () => {
    const ci = bootstrapDiffCI(mkContribs(1, 0.1, 0.3));
    expect(ci.settles).toBe(1);
    expect(Number.isNaN(ci.lo95)).toBe(true);
  });
});
