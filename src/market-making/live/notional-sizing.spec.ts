import { quoteUnitsForNotional } from './notional-sizing';

describe('quoteUnitsForNotional', () => {
  const FALLBACK = 50_000_000_000n; // the old fixed default

  it('sizes a $ notional by price into 6-decimal asset units', () => {
    // $50k of a $66,000 perp ≈ 0.757576 units.
    expect(quoteUnitsForNotional(50_000, 66_000, FALLBACK)).toBe(757576n);
    // $50k of a $1 stablecoin = 50,000 units.
    expect(quoteUnitsForNotional(50_000, 1, FALLBACK)).toBe(50_000_000_000n);
    // $50k of a $0.001 token = 50,000,000 units (a big lot, correctly).
    expect(quoteUnitsForNotional(50_000, 0.001, FALLBACK)).toBe(50_000_000_000_000n);
  });

  it('does NOT over-size a high-priced perp the way fixed units would', () => {
    const units = quoteUnitsForNotional(50_000, 66_000, FALLBACK);
    expect(units).toBeLessThan(FALLBACK); // 0.76 units, not 50,000 units of BTC
  });

  it('falls back to fixed units when notional or price is unusable', () => {
    expect(quoteUnitsForNotional(0, 66_000, FALLBACK)).toBe(FALLBACK);
    expect(quoteUnitsForNotional(-5, 66_000, FALLBACK)).toBe(FALLBACK);
    expect(quoteUnitsForNotional(50_000, 0, FALLBACK)).toBe(FALLBACK);
    expect(quoteUnitsForNotional(50_000, NaN, FALLBACK)).toBe(FALLBACK);
  });
});
