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
    gateEvents: [],
    blockedEntries: 0,
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
      scenario: 'calm' as const,
      currentZ: r.spreadSeries[r.spreadSeries.length - 1].zScore,
      regime: r.spreadSeries[r.spreadSeries.length - 1].position,
      openPnlUnits: 0n,
      metrics: r.metrics,
      recentTrades: r.trades,
      allTrades: r.trades,
      spreadSeries: r.spreadSeries,
      equityCurve: r.spreadSeries.map((_, i) => (i === r.trades[r.trades.length - 1].closeIndex ? r.metrics.totalPnlUnits : 0n)),
      refits: [],
      gateEvents: [],
      riskEvents: [],
      blockedEntries: 0,
    }),
    reset: () => undefined,
    refits: () => [],
    bars: (_which: 'a' | 'b') => [
      { symbol: 'BTC', timestamp: new Date('2026-01-01T00:00:00Z'), open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
      { symbol: 'BTC', timestamp: new Date('2026-01-01T00:01:00Z'), open: 100.5, high: 102, low: 100, close: 101.2, volume: 1 },
    ],
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

  it('GET /refits returns the refit history serialised', async () => {
    const svc: Partial<DemoService> = {
      hasResult: () => true,
      runFreshBacktest: async () => fakeResult(),
      refits: () => [
        { beta: 1.05, pValue: 0.02, halfLifeBars: 7.5, fittedAtIndex: 59 },
        { beta: 0.98, pValue: 0.30, halfLifeBars: Number.POSITIVE_INFINITY, fittedAtIndex: 79 },
      ],
    };
    const c = new DemoController(svc as unknown as DemoService);
    const res = await c.refits();
    expect(res.refits).toEqual([
      { beta: 1.05, pValue: 0.02, halfLifeBars: 7.5, fittedAtIndex: 59 },
      // Infinity half-life serialised as 0 (the dashboard renders that as 'n/a').
      { beta: 0.98, pValue: 0.30, halfLifeBars: 0, fittedAtIndex: 79 },
    ]);
  });

  it('GET /refits lazily runs a backtest if no result yet', async () => {
    let ran = 0;
    const svc: Partial<DemoService> = {
      hasResult: () => false,
      runFreshBacktest: async () => {
        ran++;
        return fakeResult();
      },
      refits: () => [],
    };
    const c = new DemoController(svc as unknown as DemoService);
    await c.refits();
    expect(ran).toBe(1);
  });

  it('GET /candles returns time as Unix seconds and bar OHLC', async () => {
    const c = new DemoController(makeService());
    const r = await c.candles('a');
    expect(r.symbol).toBe('a');
    expect(r.candles.length).toBe(2);
    expect(r.candles[0].time).toBe(Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000));
    expect(r.candles[0].open).toBeCloseTo(100);
    expect(r.candles[0].close).toBeCloseTo(100.5);
  });

  it('GET /candles defaults to symbol "a" when unspecified', async () => {
    const c = new DemoController(makeService());
    const r = await c.candles(undefined);
    expect(r.symbol).toBe('a');
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
