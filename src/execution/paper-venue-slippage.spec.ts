import { PaperVenue } from './paper-venue';

// Slippage moves the fill adversely: BUY fills above mid, SELL below.
describe('PaperVenue slippage', () => {
  const mid = 100_000_000n; // 100 USDC mid
  const deps = (side: 'BUY' | 'SELL') => ({
    pricePoller: async () => mid,
    takerFeeBps: 0n,
    // notional/adv = 100/1000 = 0.1; lambda 100 bps -> 10 bps impact.
    slippage: { advUnits: 1_000_000_000n, lambdaBps: 100 },
    _side: side,
  });

  it('BUY fills above mid by the modelled impact', async () => {
    const v = new PaperVenue(deps('BUY'));
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100_000_000n, idempotencyKey: 'k1' });
    expect(fill.priceMicros).toBe(100_100_000n); // +10 bps
  });

  it('SELL fills below mid by the modelled impact', async () => {
    const v = new PaperVenue(deps('SELL'));
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 100_000_000n, idempotencyKey: 'k2' });
    expect(fill.priceMicros).toBe(99_900_000n); // -10 bps
  });

  it('no slippage config -> frictionless fill at mid', async () => {
    const v = new PaperVenue({ pricePoller: async () => mid, takerFeeBps: 0n });
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100_000_000n, idempotencyKey: 'k3' });
    expect(fill.priceMicros).toBe(mid);
  });
});
