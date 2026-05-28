import { MultiVenueOrderRouter } from './multi-venue-router';
import { TwapAlgo } from './twap';
import { VenueCapGate } from '../stat-arb/risk/venue-cap';
import { ITradingVenue, PlaceOrderRequest, Fill } from '../stat-arb/trading-venue.interface';

function fakeVenue(id: string): ITradingVenue & { hits: number } {
  const out: ITradingVenue & { hits: number } = {
    venueId: id,
    hits: 0,
    placeOrder: async (req: PlaceOrderRequest): Promise<Fill> => {
      out.hits++;
      return {
        orderId: `${id}-${out.hits}`,
        symbol: req.symbol,
        side: req.side,
        filledUnits: req.notionalUnits,
        priceMicros: 50_000_000_000n,
        feesUnits: 0n,
        executedAt: new Date(),
      };
    },
    fetchPrice: async () => 50_000_000_000n,
  };
  return out;
}

const algo = () => new TwapAlgo({ horizonMs: 60_000 });

describe('MultiVenueOrderRouter', () => {
  it('plan routes notional across venues', () => {
    const router = new MultiVenueOrderRouter(algo(), [
      { venueId: 'a', advUnits: 100_000_000n },
      { venueId: 'b', advUnits: 300_000_000n },
    ]);
    const plan = router.plan({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 });
    expect(plan.routes.length).toBe(2);
    expect(plan.totalAllocatedUnits).toBe(1_000_000n);
  });

  it('plan slices each venue allocation via the algo', () => {
    const router = new MultiVenueOrderRouter(algo(), [
      { venueId: 'a', advUnits: 100_000_000n },
      { venueId: 'b', advUnits: 300_000_000n },
    ]);
    const plan = router.plan({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 });
    for (const r of plan.routes) {
      expect(r.children.length).toBe(4);
      const sum = r.children.reduce((s, c) => s + c.notionalUnits, 0n);
      expect(sum).toBe(r.allocationUnits);
    }
  });

  it('execute dispatches children to the matching venue', async () => {
    const a = fakeVenue('a');
    const b = fakeVenue('b');
    const router = new MultiVenueOrderRouter(algo(), [
      { venueId: 'a', advUnits: 100_000_000n },
      { venueId: 'b', advUnits: 300_000_000n },
    ]);
    const r = await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [a, b],
    );
    expect(r.filledNotionalUnits).toBe(1_000_000n);
    expect(a.hits).toBeGreaterThan(0);
    expect(b.hits).toBeGreaterThan(0);
    // b has 3x ADV so receives more children's notional.
    expect(b.hits + a.hits).toBe(8); // 4 children per venue
  });

  it('execute throws when a route has no matching ITradingVenue', async () => {
    const router = new MultiVenueOrderRouter(algo(), [
      { venueId: 'a', advUnits: 100_000_000n },
      { venueId: 'b', advUnits: 100_000_000n },
    ]);
    await expect(
      router.execute(
        { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
        [fakeVenue('a')],
      ),
    ).rejects.toThrow();
  });

  it('execute consults venueCapGate per child and skips breaching ones', async () => {
    const a = fakeVenue('a');
    const gate = new VenueCapGate({ maxNotionalUnitsPerVenue: 250_000n });
    const router = new MultiVenueOrderRouter(
      algo(),
      [{ venueId: 'a', advUnits: 1_000_000_000n }],
      { venueCapGate: gate },
    );
    // Parent 1M across 4 children of 250k. After 1 child, live = 250k → next
    // child would push to 500k > cap. Three should be blocked.
    const r = await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [a],
    );
    expect(a.hits).toBe(1);
    expect(r.blockedByCapCount).toBe(3);
    expect(r.filledNotionalUnits).toBe(250_000n);
  });

  it('execute honors initialLiveNotional when checking the gate', async () => {
    const a = fakeVenue('a');
    const gate = new VenueCapGate({ maxNotionalUnitsPerVenue: 250_000n });
    const router = new MultiVenueOrderRouter(
      algo(),
      [{ venueId: 'a', advUnits: 1_000_000_000n }],
      { venueCapGate: gate, initialLiveNotional: new Map([['a', 250_000n]]) },
    );
    // Cap already met by initial live notional — every child is blocked.
    const r = await router.execute(
      { symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 },
      [a],
    );
    expect(a.hits).toBe(0);
    expect(r.blockedByCapCount).toBe(4);
    expect(r.filledNotionalUnits).toBe(0n);
  });

  it('plan reports estCostUnits per route', () => {
    const router = new MultiVenueOrderRouter(algo(), [
      { venueId: 'a', advUnits: 100_000_000n },
      { venueId: 'b', advUnits: 300_000_000n },
    ]);
    const plan = router.plan({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 4 });
    const sum = plan.routes.reduce((s, r) => s + r.estCostUnits, 0n);
    expect(sum).toBe(plan.totalEstCostUnits);
  });

  it('throws when constructed with no liquidity entries', () => {
    expect(() => new MultiVenueOrderRouter(algo(), [])).toThrow();
  });
});
