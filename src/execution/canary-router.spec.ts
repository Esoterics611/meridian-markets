import { CanaryRouter } from './canary-router';
import { PaperVenue } from './paper-venue';
import { ITradingVenue, Fill, PlaceOrderRequest } from '../stat-arb/trading-venue.interface';

function recorderVenue(id: string): ITradingVenue & { calls: PlaceOrderRequest[] } {
  const out: ITradingVenue & { calls: PlaceOrderRequest[] } = {
    venueId: id,
    calls: [],
    placeOrder: async (req): Promise<Fill> => {
      out.calls.push(req);
      return {
        orderId: `${id}-${out.calls.length}`,
        symbol: req.symbol,
        side: req.side,
        filledUnits: req.notionalUnits,
        priceMicros: 1_000_000n,
        feesUnits: 0n,
        executedAt: new Date(),
      };
    },
    fetchPrice: async () => 1_000_000n,
  };
  return out;
}

function paper() {
  return new PaperVenue({ pricePoller: async () => 1_000_000n, venueId: 'paper' });
}

describe('CanaryRouter', () => {
  it('default 100% paper sends nothing to the real venue', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 100 });
    await c.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k1' });
    expect(real.calls.length).toBe(0);
  });

  it('0% paper sends everything to the real venue', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 0 });
    await c.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k2' });
    expect(real.calls.length).toBe(1);
    expect(real.calls[0].notionalUnits).toBe(1_000n);
  });

  it('splits proportionally and idempotency-keys are leg-specific', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 20 });
    const split = await c.placeOrderSplit({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k3' });
    expect(split.paperFill?.filledUnits).toBe(200n);
    expect(split.realFill?.filledUnits).toBe(800n);
    expect(real.calls[0].idempotencyKey).toBe('k3-real');
  });

  it('aggregate fill has totalFilled = paperFill + realFill', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 50 });
    const fill = await c.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k4' });
    expect(fill.filledUnits).toBe(1_000n);
  });

  it('aggregate fill uses notional-weighted price', async () => {
    const realPx = 2_000_000n;
    const real: ITradingVenue = {
      venueId: 'real',
      placeOrder: async (req): Promise<Fill> => ({
        orderId: 'r-1',
        symbol: req.symbol,
        side: req.side,
        filledUnits: req.notionalUnits,
        priceMicros: realPx,
        feesUnits: 0n,
        executedAt: new Date(),
      }),
      fetchPrice: async () => realPx,
    };
    const c = new CanaryRouter(paper(), real, { paperPct: 50 });
    const fill = await c.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k5' });
    // weighted avg of paper 1e6 and real 2e6 with equal weights → 1.5e6
    expect(fill.priceMicros).toBe(1_500_000n);
  });

  it('throws on invalid paperPct', () => {
    expect(() => new CanaryRouter(paper(), recorderVenue('real'), { paperPct: -1 })).toThrow();
    expect(() => new CanaryRouter(paper(), recorderVenue('real'), { paperPct: 101 })).toThrow();
  });

  it('preserves the parent side on both legs', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 50 });
    await c.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 100n, idempotencyKey: 'k7' });
    expect(real.calls[0].side).toBe('SELL');
  });

  it('venueId reports both legs', () => {
    const c = new CanaryRouter(paper(), recorderVenue('real-binance'), { paperPct: 50 });
    expect(c.venueId).toBe('canary(paper+real-binance)');
  });

  it('fetchPrice delegates to the real venue', async () => {
    const real: ITradingVenue = { ...recorderVenue('real'), fetchPrice: async () => 7_777_777n };
    const c = new CanaryRouter(paper(), real, { paperPct: 100 });
    expect(await c.fetchPrice('BTC')).toBe(7_777_777n);
  });

  it('split fills include a source label per leg', async () => {
    const real = recorderVenue('real');
    const c = new CanaryRouter(paper(), real, { paperPct: 30 });
    const out = await c.placeOrderSplit({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k8' });
    expect(out.paperFill?.source).toBe('paper');
    expect(out.realFill?.source).toBe('real');
    expect(out.paperFill?.parentNotionalUnits).toBe(1_000n);
    expect(out.realFill?.parentNotionalUnits).toBe(1_000n);
  });
});
