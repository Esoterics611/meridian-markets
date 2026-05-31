import { scoreMmSuitability } from './mm-suitability-scorer';

const base = { rebateBps: 1, quoteHalfSpreadBps: 1, barsPerDay: 1440, adverseCoef: 0.5 };

describe('scoreMmSuitability', () => {
  it('rates a calm, rebated, fillable instrument as attractive', () => {
    const s = scoreMmSuitability({ ...base, volatility: 0.0002, avgRangeBps: 4 });
    expect(s.attractive).toBe(true);
    expect(s.netPerRoundTripBps).toBeGreaterThan(0);
    expect(s.scorePerDayBps).toBeGreaterThan(0);
  });

  it('rejects a high-vol instrument where adverse selection swamps the spread', () => {
    const s = scoreMmSuitability({ ...base, volatility: 0.02, avgRangeBps: 400 });
    expect(s.attractive).toBe(false);
    expect(s.netPerRoundTripBps).toBeLessThan(0);
  });

  it('ranks the calmer instrument higher', () => {
    const calm = scoreMmSuitability({ ...base, volatility: 0.0002, avgRangeBps: 4 });
    const wild = scoreMmSuitability({ ...base, volatility: 0.02, avgRangeBps: 400 });
    expect(calm.scorePerDayBps).toBeGreaterThan(wild.scorePerDayBps);
  });

  it('credits the maker rebate', () => {
    const withRebate = scoreMmSuitability({ ...base, rebateBps: 2, volatility: 0.0002, avgRangeBps: 4 });
    const noRebate = scoreMmSuitability({ ...base, rebateBps: 0, volatility: 0.0002, avgRangeBps: 4 });
    expect(withRebate.netPerRoundTripBps).toBeGreaterThan(noRebate.netPerRoundTripBps);
  });
});
