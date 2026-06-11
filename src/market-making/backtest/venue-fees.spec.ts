import { venueFeeFor, makerBpsFor } from './venue-fees';

describe('venueFeeFor', () => {
  it('returns the HL maker rebate (the venue the book is built for)', () => {
    const f = venueFeeFor('hyperliquid');
    expect(f.makerBps).toBe(-0.2); // rebate = revenue
    expect(f.takerBps).toBeGreaterThan(0);
  });

  it('returns Binance + GeckoTerminal (AMM) maker costs', () => {
    expect(venueFeeFor('binance').makerBps).toBe(1);
    expect(venueFeeFor('geckoterminal').makerBps).toBe(5); // AMM LP fee, a cost (no rebate)
  });

  it('is case-insensitive and defaults to Binance when unset', () => {
    expect(venueFeeFor('HYPERLIQUID').makerBps).toBe(-0.2);
    expect(venueFeeFor(undefined).makerBps).toBe(venueFeeFor('binance').makerBps);
  });

  it('falls back to a structural-only (0bps maker) default for an unknown venue', () => {
    expect(venueFeeFor('mysteryswap').makerBps).toBe(0);
    expect(makerBpsFor('mysteryswap')).toBe(0);
  });

  it('makerBpsFor matches the schedule', () => {
    expect(makerBpsFor('hyperliquid')).toBe(-0.2);
  });

  it('HIP-3 (dex-prefixed) HL books get the no-rebate HIP-3 schedule, main-dex keeps the rebate', () => {
    const hip3 = venueFeeFor('hyperliquid', 'xyz:GOLD');
    expect(hip3.makerBps).toBeGreaterThan(0); // a COST — never pay ourselves an unverified rebate
    expect(hip3.takerBps).toBeGreaterThan(0);
    expect(venueFeeFor('hyperliquid', 'BTC').makerBps).toBe(-0.2);
    expect(makerBpsFor('hyperliquid', 'xyz:GOLD')).toBe(hip3.makerBps);
    // the prefix rule is HL-specific — other venues are untouched by the symbol hint
    expect(venueFeeFor('binance', 'xyz:GOLD').makerBps).toBe(1);
  });
});
