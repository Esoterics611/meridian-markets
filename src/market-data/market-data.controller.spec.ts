import { alignMany, MarketDataController } from './market-data.controller';
import { Bar } from '../stat-arb/backtest/bar';
import { generateSyntheticFeed } from '../stat-arb/backtest/synthetic-feed';
import { ReplayEngine } from './replay/replay-engine';

function bar(t: number, close: number): Bar {
  return { symbol: 'X', timestamp: new Date(t), open: close, high: close, low: close, close, volume: 1 };
}

/** A controller whose ReplayEngine serves a cointegrated synthetic pair as if it
 *  were stored real history — lets us exercise the real-history walk-forward path
 *  without a DB. The other deps are unused by walkForwardReal(). */
function controllerWithFeed(barCount: number, symbolA = 'AAA', symbolB = 'BBB'): MarketDataController {
  const { a, b } = generateSyntheticFeed({
    symbolA, symbolB, barCount,
    spreadPeriodBars: 25, spreadAmplitude: 0.05,
    basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
  const replay = { loadPairWindow: async () => ({ a, b }) } as unknown as ReplayEngine;
  return new MarketDataController(undefined as never, undefined as never, replay, undefined as never);
}

describe('alignMany', () => {
  it('keeps only timestamps present in every symbol series (inner join)', () => {
    const m = new Map<string, Bar[]>([
      ['A', [bar(1, 10), bar(2, 11), bar(3, 12)]],
      ['B', [bar(2, 20), bar(3, 21), bar(4, 22)]],
      ['C', [bar(2, 30), bar(3, 31)]],
    ]);
    const out = alignMany(m);
    // Only t=2 and t=3 are in all three.
    for (const sym of ['A', 'B', 'C']) {
      expect(out.get(sym)!.map((b) => b.timestamp.getTime())).toEqual([2, 3]);
    }
  });

  it('returns equal-length aligned series', () => {
    const m = new Map<string, Bar[]>([
      ['A', [bar(1, 1), bar(2, 2)]],
      ['B', [bar(1, 1), bar(2, 2), bar(3, 3)]],
    ]);
    const out = alignMany(m);
    const lengths = [...out.values()].map((b) => b.length);
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(2);
  });

  it('handles the empty map', () => {
    expect(alignMany(new Map()).size).toBe(0);
  });
});

describe('MarketDataController — walk-forward on real history (OOS)', () => {
  it('returns the OOS headline + per-window train/test with a train-fit β', async () => {
    const c = controllerWithFeed(800);
    const r: any = await c.walkForwardReal({ symbolA: 'AAA', symbolB: 'BBB', trainBars: 200, testBars: 100 });
    expect(r.source).toBe('real-binance-history');
    expect(r.split.windows).toBeGreaterThan(0);
    expect(r.windows.length).toBe(r.split.windows);
    expect(typeof r.oos.avgTestSharpe).toBe('number');
    expect(typeof r.oos.sharpeDegradation).toBe('number');
    expect(r.betaFit).toBe('refit-per-train-window');
    // bigints serialise to strings; each window carries its train-fit β.
    expect(typeof r.oos.totalTestPnlUnits).toBe('string');
    expect(typeof r.windows[0].test.totalPnlUnits).toBe('string');
    expect(typeof r.windows[0].beta).toBe('number');
    // β fit on a ~25× price ratio in log-space ≈ 1.
    expect(r.windows[0].beta).toBeGreaterThan(0.5);
    expect(r.windows[0].beta).toBeLessThan(1.5);
  });

  it('guards when there are not enough overlapping bars for even one window', async () => {
    const c = controllerWithFeed(120);
    const r: any = await c.walkForwardReal({ symbolA: 'AAA', symbolB: 'BBB', trainBars: 300, testBars: 100 });
    expect(r.error).toMatch(/not enough/i);
    expect(r.need).toBe(400);
  });

  it('pins β across windows when a beta is supplied (betaFit=pinned)', async () => {
    const c = controllerWithFeed(800);
    const r: any = await c.walkForwardReal({ symbolA: 'AAA', symbolB: 'BBB', trainBars: 200, testBars: 100, beta: 25 });
    expect(r.betaFit).toBe('pinned');
    for (const w of r.windows) expect(w.beta).toBe(25);
  });
});
