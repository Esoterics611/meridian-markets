import { PaperVenue } from './paper-venue';

const fixedNow = new Date('2026-05-28T12:00:00Z');

function venue(opts?: { price?: bigint }) {
  const price = opts?.price ?? 1_000_000n;
  return new PaperVenue({
    pricePoller: async () => price,
    now: () => fixedNow,
  });
}

describe('PaperVenue', () => {
  it('fills an order with the polled price', async () => {
    const v = venue({ price: 50_000_000_000n });
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k1' });
    expect(fill.priceMicros).toBe(50_000_000_000n);
    expect(fill.filledUnits).toBe(1_000n);
  });

  it('charges taker fee at default 5 bps', async () => {
    const v = venue();
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 10_000n, idempotencyKey: 'k2' });
    // 10_000 * 5 / 10_000 = 5
    expect(fill.feesUnits).toBe(5n);
  });

  it('replays the same fill on repeat idempotencyKey', async () => {
    const v = venue();
    const a = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100n, idempotencyKey: 'k3' });
    const b = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 999n, idempotencyKey: 'k3' });
    expect(b.orderId).toBe(a.orderId);
    expect(b.filledUnits).toBe(100n); // cached size, not the new request
  });

  it('throws on non-positive notional', async () => {
    const v = venue();
    await expect(v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 0n, idempotencyKey: 'k' })).rejects.toThrow();
  });

  it('tracks per-symbol long and short notionals', async () => {
    const v = venue();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k4' });
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 500n, idempotencyKey: 'k5' });
    await v.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 200n, idempotencyKey: 'k6' });
    const pos = v.positionSnapshot()[0];
    expect(pos.longUnits).toBe(1_500n);
    expect(pos.shortUnits).toBe(200n);
  });

  it('netNotional returns long minus short', async () => {
    const v = venue();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k7' });
    await v.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 300n, idempotencyKey: 'k8' });
    expect(v.netNotional('BTC')).toBe(700n);
  });

  it('bookSnapshot lists every paper fill', async () => {
    const v = venue();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100n, idempotencyKey: 'k9' });
    await v.placeOrder({ symbol: 'ETH', side: 'SELL', notionalUnits: 200n, idempotencyKey: 'k10' });
    expect(v.bookSnapshot().length).toBe(2);
  });

  it('fetchPrice returns the polled price', async () => {
    const v = venue({ price: 12_345n });
    expect(await v.fetchPrice('BTC')).toBe(12_345n);
  });

  it('venueId defaults to paper but is overridable', async () => {
    const v = new PaperVenue({ pricePoller: async () => 1n, venueId: 'paper-binance' });
    expect(v.venueId).toBe('paper-binance');
  });

  it('orderId carries the venueId prefix', async () => {
    const v = new PaperVenue({ pricePoller: async () => 1n, venueId: 'paper-binance' });
    const fill = await v.placeOrder({ symbol: 'X', side: 'BUY', notionalUnits: 1n, idempotencyKey: 'kX' });
    expect(fill.orderId.startsWith('paper-binance-paper-')).toBe(true);
  });

  it('uses an injected clock for executedAt', async () => {
    const v = venue();
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'kt' });
    expect(fill.executedAt.toISOString()).toBe(fixedNow.toISOString());
  });

  it('respects a custom takerFeeBps', async () => {
    const v = new PaperVenue({ pricePoller: async () => 1n, takerFeeBps: 10n });
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 10_000n, idempotencyKey: 'kx' });
    expect(fill.feesUnits).toBe(10n); // 10_000 * 10 / 10_000 = 10
  });

  it('reset clears the book and positions', async () => {
    const v = venue();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'kr' });
    v.reset();
    expect(v.bookSnapshot()).toEqual([]);
    expect(v.positionSnapshot()).toEqual([]);
  });

  it('side defaults are honored separately', async () => {
    const v = venue();
    const buy = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100n, idempotencyKey: 'kb' });
    const sell = await v.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 100n, idempotencyKey: 'ks' });
    expect(buy.side).toBe('BUY');
    expect(sell.side).toBe('SELL');
  });

  it('orderIds are unique per fill', async () => {
    const v = venue();
    const a = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100n, idempotencyKey: 'a' });
    const b = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100n, idempotencyKey: 'b' });
    expect(a.orderId).not.toBe(b.orderId);
  });
});
