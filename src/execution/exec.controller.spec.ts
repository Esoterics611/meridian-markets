import { ExecController } from './exec.controller';
import { ExecDemoService, ExecEvent } from './exec-demo.service';

function stubSvc(): { svc: ExecDemoService; runs: any[] } {
  const runs: any[] = [];
  const svc = {
    runDemoOrder: async (opts: any): Promise<ExecEvent> => {
      runs.push(opts);
      return {
        id: 'evt-1',
        ts: new Date('2026-05-28T00:00:00Z'),
        algoId: opts.algoId,
        parent: { symbol: 'BTC', side: opts.side, totalNotionalUnits: opts.notionalUnits },
        routes: [{ venueId: 'mock-a', allocationUnits: opts.notionalUnits, estImpactBps: 1, estCostUnits: 100n, childCount: 4 }],
        totalEstCostUnits: 100n,
        filledNotionalUnits: opts.notionalUnits,
        blockedByCapCount: 0,
        realisedCostUnits: 100n,
        underfilled: false,
      };
    },
    recent: () => [],
    reset: () => {},
  } as unknown as ExecDemoService;
  return { svc, runs };
}

describe('ExecController', () => {
  it('POST /run forwards query params to the service', async () => {
    const { svc, runs } = stubSvc();
    const ctrl = new ExecController(svc);
    const r = await ctrl.run('vwap', '500000', 'SELL');
    expect(runs[0].algoId).toBe('vwap');
    expect(runs[0].notionalUnits).toBe(500_000n);
    expect(runs[0].side).toBe('SELL');
    expect(r.routes.length).toBe(1);
  });

  it('serialises bigints as strings in the response', async () => {
    const { svc } = stubSvc();
    const ctrl = new ExecController(svc);
    const r = await ctrl.run('twap', '1000000', 'BUY');
    expect(typeof r.parent.totalNotionalUnits).toBe('string');
    expect(typeof r.totalEstCostUnits).toBe('string');
    expect(typeof r.filledNotionalUnits).toBe('string');
  });

  it('GET /recent returns the wrapped events list', () => {
    const { svc } = stubSvc();
    (svc as any).recent = () => [];
    const ctrl = new ExecController(svc);
    expect(ctrl.recent().events).toEqual([]);
  });

  it('POST /reset returns ok', () => {
    const { svc } = stubSvc();
    const ctrl = new ExecController(svc);
    expect(ctrl.reset()).toEqual({ ok: true });
  });

  it('defaults invalid algo to twap', async () => {
    const { svc, runs } = stubSvc();
    const ctrl = new ExecController(svc);
    await ctrl.run('garbage', '1000', 'BUY');
    expect(runs[0].algoId).toBe('twap');
  });

  it('defaults invalid notional to 1_000_000', async () => {
    const { svc, runs } = stubSvc();
    const ctrl = new ExecController(svc);
    await ctrl.run('twap', 'not-a-number', 'BUY');
    expect(runs[0].notionalUnits).toBe(1_000_000n);
  });
});
