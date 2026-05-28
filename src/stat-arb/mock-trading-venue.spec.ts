import { MockTradingVenue } from './mock-trading-venue';

describe('MockTradingVenue', () => {
  const fixedClock = (iso: string) => () => new Date(iso);

  it('placeOrder returns a filled order with positive fee', async () => {
    const v = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const fill = await v.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      notionalUnits: 1_000_000n, // 1 USDC
      idempotencyKey: 'k1',
    });
    expect(fill.symbol).toBe('BTC');
    expect(fill.filledUnits).toBe(1_000_000n);
    expect(fill.feesUnits).toBe(500n); // 5 bps of 1_000_000
    expect(fill.priceMicros).toBeGreaterThan(0n);
  });

  it('is idempotent on repeated key', async () => {
    const v = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const req = { symbol: 'ETH', side: 'BUY' as const, notionalUnits: 1_000_000n, idempotencyKey: 'k1' };
    const a = await v.placeOrder(req);
    const b = await v.placeOrder(req);
    expect(a).toEqual(b);
  });

  it('rejects non-positive notional', async () => {
    const v = new MockTradingVenue();
    await expect(
      v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 0n, idempotencyKey: 'k' }),
    ).rejects.toThrow(/> 0/);
  });

  it('fetchPrice is deterministic for a fixed clock and symbol', async () => {
    const v1 = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const v2 = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const a = await v1.fetchPrice('BTC');
    const b = await v2.fetchPrice('BTC');
    expect(a).toBe(b);
  });

  it('fetchPrice varies across symbols', async () => {
    const v = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const a = await v.fetchPrice('BTC');
    const b = await v.fetchPrice('ETH');
    expect(a).not.toBe(b);
  });

  it('fetchPrice changes across time (sine oscillation)', async () => {
    const v1 = new MockTradingVenue(5n, fixedClock('2026-02-01T00:00:00Z'));
    const v2 = new MockTradingVenue(5n, fixedClock('2026-02-01T00:30:00Z'));
    const a = await v1.fetchPrice('BTC');
    const b = await v2.fetchPrice('BTC');
    expect(a).not.toBe(b);
  });
});
