import { ConfigService } from '@nestjs/config';
import { ExecDemoService } from './exec-demo.service';
import { ITradingVenue, PlaceOrderRequest, Fill } from '../stat-arb/trading-venue.interface';
import { AppConfig } from '@config/app-config.interface';

function stubVenue(): ITradingVenue {
  return {
    venueId: 'stub',
    placeOrder: async (req: PlaceOrderRequest): Promise<Fill> => ({
      orderId: 'stub-1',
      symbol: req.symbol,
      side: req.side,
      filledUnits: req.notionalUnits,
      priceMicros: 1_000_000n,
      feesUnits: 0n,
      executedAt: new Date(),
    }),
    fetchPrice: async () => 1_000_000n,
  };
}

function stubConfig(): ConfigService {
  const cfg: Partial<AppConfig> = {
    statArb: { mockEnabled: true, demoBarCount: 90, demoPairA: 'BTC', demoPairB: 'ETH' },
  };
  return { getOrThrow: () => cfg } as unknown as ConfigService;
}

describe('ExecDemoService', () => {
  it('runDemoOrder produces an ExecEvent with at least one route', async () => {
    const svc = new ExecDemoService(stubConfig(), stubVenue());
    const evt = await svc.runDemoOrder({ algoId: 'twap', notionalUnits: 1_000_000n, side: 'BUY' });
    expect(evt.routes.length).toBeGreaterThan(0);
    expect(evt.parent.totalNotionalUnits).toBe(1_000_000n);
  });

  it('records ExecEvents into the recent history', async () => {
    const svc = new ExecDemoService(stubConfig(), stubVenue());
    await svc.runDemoOrder({ algoId: 'twap', notionalUnits: 1_000_000n, side: 'BUY' });
    await svc.runDemoOrder({ algoId: 'vwap', notionalUnits: 500_000n, side: 'SELL' });
    const recent = svc.recent();
    expect(recent.length).toBe(2);
    // newest first
    expect(recent[0].algoId).toBe('vwap');
    expect(recent[1].algoId).toBe('twap');
  });

  it('blocks-by-cap when parent notional > venue caps', async () => {
    const svc = new ExecDemoService(stubConfig(), stubVenue());
    // Big parent — demo VenueCapGate caps each venue at 30% of parent. The
    // multi-venue split routes proportional to ADV; with 3 venues of 400/200/100M
    // the largest gets ~57% of parent which exceeds the 30% cap → blocked.
    const evt = await svc.runDemoOrder({ algoId: 'twap', notionalUnits: 10_000_000n, side: 'BUY' });
    expect(evt.blockedByCapCount).toBeGreaterThan(0);
  });

  it('supports each algoId', async () => {
    const svc = new ExecDemoService(stubConfig(), stubVenue());
    for (const algo of ['twap', 'vwap', 'pov', 'iceberg'] as const) {
      const evt = await svc.runDemoOrder({ algoId: algo, notionalUnits: 1_000_000n, side: 'BUY' });
      expect(evt.algoId).toBe(algo);
    }
  });

  it('reset clears the history', async () => {
    const svc = new ExecDemoService(stubConfig(), stubVenue());
    await svc.runDemoOrder({ algoId: 'twap', notionalUnits: 1_000_000n, side: 'BUY' });
    svc.reset();
    expect(svc.recent()).toEqual([]);
  });
});
