import {
  trailingRealisedVol,
  trailingReversal,
  volScaledMomentum,
  trailingMomentum,
  regimeSignalSeries,
  defaultRegimeSignalSpecs,
} from './regime-signals';

describe('regime-signals P12 additions (no-look-ahead, known-answer)', () => {
  describe('trailingReversal', () => {
    it('is the exact negation of trailing momentum', () => {
      const prices = [100, 110, 121, 133.1, 146.41];
      const mom = trailingMomentum(prices, 2);
      const rev = trailingReversal(prices, 2);
      for (let i = 0; i < prices.length; i++) {
        if (Number.isFinite(mom[i])) expect(rev[i]).toBeCloseTo(-mom[i], 12);
        else expect(Number.isNaN(rev[i])).toBe(true);
      }
    });
    it('is NaN over the warmup (no look-ahead into earlier-than-existing bars)', () => {
      const rev = trailingReversal([100, 101, 102], 3);
      expect(Number.isNaN(rev[0])).toBe(true);
      expect(Number.isNaN(rev[1])).toBe(true);
      expect(Number.isNaN(rev[2])).toBe(true); // i=3 would be first defined, out of range
    });
  });

  describe('trailingRealisedVol', () => {
    it('is the sample stdev of the last L one-bar log returns', () => {
      // constant +10% per bar ⇒ every log return identical ⇒ zero stdev.
      const flatGrowth = [100, 110, 121, 133.1, 146.41];
      const vol = trailingRealisedVol(flatGrowth, 3);
      expect(vol[4]).toBeCloseTo(0, 9);
    });
    it('is NaN until the lookback window is full', () => {
      const vol = trailingRealisedVol([100, 101, 102], 3);
      expect(Number.isNaN(vol[2])).toBe(true);
    });
  });

  describe('volScaledMomentum', () => {
    it('is momentum / realised-vol where both are defined', () => {
      const prices = [100, 102, 99, 105, 103, 108, 106];
      const mom = trailingMomentum(prices, 4);
      const vol = trailingRealisedVol(prices, 4);
      const vsm = volScaledMomentum(prices, 4);
      const i = 6;
      expect(vsm[i]).toBeCloseTo(mom[i] / vol[i], 9);
    });
    it('is NaN when realised vol is zero (constant-growth ⇒ no risk to scale by)', () => {
      const flatGrowth = [100, 110, 121, 133.1, 146.41];
      const vsm = volScaledMomentum(flatGrowth, 3);
      expect(Number.isNaN(vsm[4])).toBe(true);
    });
  });

  it('regimeSignalSeries dispatches every kind without drift', () => {
    const prices = [100, 101, 103, 102, 105, 107, 106, 109];
    const series = { prices, barTimesMs: prices.map((_, i) => i * 3_600_000), funding: [] };
    expect(regimeSignalSeries({ name: 'rev', kind: 'reversal', lookbackBars: 2 }, series)).toEqual(trailingReversal(prices, 2));
    expect(regimeSignalSeries({ name: 'vsm', kind: 'vol-scaled-momentum', lookbackBars: 3 }, series)).toEqual(volScaledMomentum(prices, 3));
  });

  it('defaultRegimeSignalSpecs includes the widened P12 family set', () => {
    const specs = defaultRegimeSignalSpecs({ intervalHours: 1 });
    const kinds = new Set(specs.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['funding-paid-side', 'momentum', 'vol-scaled-momentum', 'reversal']));
  });
});
