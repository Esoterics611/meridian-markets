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
});
