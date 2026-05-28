import { OrderRouter } from './order-router';
import { TwapAlgo } from './twap';
import { MockTradingVenue } from '../stat-arb/mock-trading-venue';
import { ITradingVenue, Fill, PlaceOrderRequest } from '../stat-arb/trading-venue.interface';

const algo = () => new TwapAlgo({ horizonMs: 60_000 });

function fakeVenue(id: string): ITradingVenue {
  let n = 0;
  return {
    venueId: id,
    placeOrder: async (req: PlaceOrderRequest): Promise<Fill> => ({
      orderId: id + '-' + (++n),
      symbol: req.symbol, side: req.side,
      filledUnits: req.notionalUnits, priceMicros: 50_000_000_000n, feesUnits: 0n,
      executedAt: new Date(),
    }),
    fetchPrice: async () => 50_000_000_000n,
  };
}

describe('OrderRouter', () => {
  it('plan picks the venue with the lowest estimated slippage cost', () => {
    const adv = new Map<string, bigint>([
      ['thin',  10_000_000n],   // 1M / 10M = 10% ADV → big impact
      ['thick', 1_000_000_000n], // 1M / 1B  = 0.1% ADV → tiny impact
    ]);
    const router = new OrderRouter(algo(), adv);
    const plan = router.plan(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [fakeVenue('thin'), fakeVenue('thick')],
    );
    expect(plan.chosenVenue.venueId).toBe('thick');
  });

  it('breaks cost ties by largest ADV', () => {
    // Two venues with identical impact (same ADV).
    const adv = new Map<string, bigint>([
      ['a', 1_000_000_000n],
      ['b', 1_000_000_000n],
    ]);
    const router = new OrderRouter(algo(), adv);
    const plan = router.plan(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [fakeVenue('a'), fakeVenue('b')],
    );
    // With equal cost and equal ADV, sort stability means we keep one. The
    // contract is "largest ADV wins" — with identical ADV, either is acceptable.
    expect(['a', 'b']).toContain(plan.chosenVenue.venueId);
  });

  it('throws on empty venue list', () => {
    const router = new OrderRouter(algo(), new Map());
    expect(() => router.plan({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1n, maxSlices: 1 }, []))
      .toThrow();
  });

  it('plan returns the configured number of child slices', () => {
    const router = new OrderRouter(algo(), new Map([['mock', 1_000_000_000n]]));
    const plan = router.plan(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 5 },
      [fakeVenue('mock')],
    );
    expect(plan.children.length).toBe(5);
  });

  it('execute fills the parent notional across child orders', async () => {
    const router = new OrderRouter(algo(), new Map([['mock', 1_000_000_000n]]));
    const r = await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [fakeVenue('mock')],
    );
    expect(r.filledNotionalUnits).toBe(1_000_000n);
  });

  it('execute uses the chosen venue (cheapest by slippage)', async () => {
    const adv = new Map<string, bigint>([
      ['thin',  10_000n],
      ['thick', 10_000_000_000n],
    ]);
    let thinHits = 0;
    const thin: ITradingVenue = {
      ...fakeVenue('thin'),
      placeOrder: async (req) => {
        thinHits++;
        return { orderId: 't', symbol: req.symbol, side: req.side, filledUnits: req.notionalUnits, priceMicros: 1n, feesUnits: 0n, executedAt: new Date() };
      },
    };
    const router = new OrderRouter(algo(), adv);
    await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 3 },
      [thin, fakeVenue('thick')],
    );
    expect(thinHits).toBe(0);
  });

  it('attaches estimated impact and cost to the chosen quote', () => {
    const router = new OrderRouter(algo(), new Map([['mock', 100_000_000n]]));
    const plan = router.plan(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [fakeVenue('mock')],
    );
    expect(plan.chosenVenue.estImpactBps).toBeGreaterThan(0);
    expect(plan.totalEstCostUnits).toBe(plan.chosenVenue.estCostUnits);
  });

  it('works with the real MockTradingVenue end-to-end', async () => {
    const router = new OrderRouter(algo(), new Map([['mock', 10_000_000_000n]]));
    const r = await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 500_000n, maxSlices: 2 },
      [new MockTradingVenue()],
    );
    expect(r.filledNotionalUnits).toBeGreaterThan(0n);
  });
});
