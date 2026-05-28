import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { BacktestResult } from '../backtest/backtest-runner';

function fakeResult(): BacktestResult {
  return {
    trades: [
      {
        openIndex: 5,
        closeIndex: 10,
        side: 'SHORT',
        entryZ: 1.5,
        exitZ: 0.2,
        pnlUnits: 1234n,
        holdBars: 5,
      },
    ],
    metrics: {
      totalPnlUnits: 1234n,
      sharpeRatio: 1.8,
      maxDrawdownPct: 2.4,
      winRate: 1.0,
      totalTrades: 1,
    },
    spreadSeries: [
      { timestamp: new Date('2026-01-01T00:00:00Z'), zScore: 0.5, position: 'FLAT' },
      { timestamp: new Date('2026-01-01T00:01:00Z'), zScore: 1.6, position: 'SHORT' },
    ],
  };
}

function makeService(): DemoService {
  const r = fakeResult();
  const svc: Partial<DemoService> & { _result: BacktestResult } = {
    _result: r,
    hasResult: () => true,
    runFreshBacktest: async () => r,
    snapshot: () => ({
      pair: { a: 'BTC', b: 'ETH' },
      generatedAt: new Date('2026-02-01T00:00:00Z'),
      currentZ: r.spreadSeries[r.spreadSeries.length - 1].zScore,
      regime: r.spreadSeries[r.spreadSeries.length - 1].position,
      openPnlUnits: 0n,
      metrics: r.metrics,
      recentTrades: r.trades,
      spreadSeries: r.spreadSeries,
    }),
    reset: () => undefined,
  };
  return svc as unknown as DemoService;
}

describe('DemoController', () => {
  it('GET /run returns a serialised BacktestResult with string pnl', async () => {
    const c = new DemoController(makeService());
    const res = await c.run();
    expect(res.metrics.totalPnlUnits).toBe('1234');
    expect(res.trades[0].pnlUnits).toBe('1234');
    expect(res.metrics.sharpeRatio).toBe(1.8);
  });

  it('GET /status returns pair + regime + currentZ', async () => {
    const c = new DemoController(makeService());
    const s = await c.status();
    expect(s.pair).toEqual({ a: 'BTC', b: 'ETH' });
    expect(s.regime).toBe('SHORT');
    expect(s.currentZ).toBeCloseTo(1.6);
  });

  it('GET /status auto-runs a backtest if no result yet', async () => {
    let ran = 0;
    const svc: Partial<DemoService> = {
      hasResult: () => false,
      runFreshBacktest: async () => {
        ran++;
        return fakeResult();
      },
      snapshot: makeService().snapshot.bind(makeService()),
    };
    // After first auto-run hasResult would flip true in the real service;
    // for the unit test the snapshot mock returns a valid object anyway.
    const c = new DemoController(svc as unknown as DemoService);
    await c.status();
    expect(ran).toBe(1);
  });

  it('GET /history returns the spreadSeries with ISO timestamps', async () => {
    const c = new DemoController(makeService());
    const res = await c.history();
    expect(res.series.length).toBe(2);
    expect(res.series[0].timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(res.series[1].position).toBe('SHORT');
  });

  it('POST /reset clears state then re-runs', async () => {
    let resetCalls = 0;
    let runCalls = 0;
    const svc: Partial<DemoService> = {
      hasResult: () => true,
      runFreshBacktest: async () => {
        runCalls++;
        return fakeResult();
      },
      snapshot: makeService().snapshot.bind(makeService()),
      reset: () => {
        resetCalls++;
      },
    };
    const c = new DemoController(svc as unknown as DemoService);
    const res = await c.reset();
    expect(resetCalls).toBe(1);
    expect(runCalls).toBe(1);
    expect(res.metrics.totalTrades).toBe(1);
  });
});
