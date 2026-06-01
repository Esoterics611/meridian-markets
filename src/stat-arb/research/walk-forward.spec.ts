import { walkForward } from './walk-forward';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { MockTradingVenue } from '../mock-trading-venue';

function feed(barCount: number) {
  return generateSyntheticFeed({
    symbolA: 'BTC', symbolB: 'ETH',
    barCount,
    spreadPeriodBars: 25,
    spreadAmplitude: 0.05,
    basePriceB: 2000,
    aOverBRatio: 25,
    barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function strategy() {
  return new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n });
}

describe('walkForward', () => {
  it('produces floor(N - trainBars / testBars) windows for evenly divisible inputs', async () => {
    const { a, b } = feed(400);
    const r = await walkForward({
      barsA: a, barsB: b,
      trainBars: 100, testBars: 50,
      strategyFactory: strategy,
      venueFactory: () => new MockTradingVenue(),
    });
    // The first test starts at 100, so test windows fit until trainStart + 150 <= 400.
    // trainStart sequence: 0, 50, 100, 150, 200, 250 — 6 windows.
    expect(r.windows.length).toBe(6);
  });

  it('each window reports both train and test metrics', async () => {
    const { a, b } = feed(300);
    const r = await walkForward({
      barsA: a, barsB: b,
      trainBars: 100, testBars: 50,
      strategyFactory: strategy,
      venueFactory: () => new MockTradingVenue(),
    });
    for (const w of r.windows) {
      expect(typeof w.train.sharpeRatio).toBe('number');
      expect(typeof w.test.sharpeRatio).toBe('number');
      expect(typeof w.test.calmar).toBe('number');
    }
  });

  it('avgTestSharpe equals mean across windows', async () => {
    const { a, b } = feed(250);
    const r = await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    });
    const manual = r.windows.reduce((s, w) => s + w.test.sharpeRatio, 0) / r.windows.length;
    expect(r.avgTestSharpe).toBeCloseTo(manual);
  });

  it('positiveWindowShare counts windows with sharpe > 0', async () => {
    const { a, b } = feed(400);
    const r = await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    });
    const expected = r.windows.filter(w => w.test.sharpeRatio > 0).length / r.windows.length;
    expect(r.positiveWindowShare).toBeCloseTo(expected);
  });

  it('returns no windows when bars are shorter than trainBars + testBars', async () => {
    const { a, b } = feed(100);
    const r = await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    });
    expect(r.windows).toEqual([]);
    expect(r.avgTestSharpe).toBe(0);
  });

  it('rejects mismatched barsA / barsB lengths', async () => {
    const { a } = feed(100);
    const { b } = feed(80);
    await expect(walkForward({
      barsA: a, barsB: b, trainBars: 50, testBars: 25,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    })).rejects.toThrow(/same length/);
  });

  it('rejects non-positive window sizes', async () => {
    const { a, b } = feed(200);
    await expect(walkForward({
      barsA: a, barsB: b, trainBars: 0, testBars: 25,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    })).rejects.toThrow();
  });

  it('uses a fresh strategy per window (no state bleed)', async () => {
    let strategiesCreated = 0;
    const { a, b } = feed(300);
    const r = await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: () => {
        strategiesCreated++;
        return strategy();
      },
      venueFactory: () => new MockTradingVenue(),
    });
    // 2 instantiations per window (train + test).
    expect(strategiesCreated).toBe(r.windows.length * 2);
  });

  it('Calmar is zero when the test window has no drawdown', async () => {
    // Construct a feed so flat the strategy never opens — guarantees zero DD.
    const flat = Array.from({ length: 200 }, (_, i) => ({
      symbol: 'A', timestamp: new Date(2026, 0, 1, 0, i),
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
    const r = await walkForward({
      barsA: flat, barsB: flat.map(x => ({ ...x, symbol: 'B' })),
      trainBars: 100, testBars: 50,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    });
    for (const w of r.windows) expect(w.test.calmar).toBe(0);
  });

  it('window boundaries are strictly contiguous in the testBars stride', async () => {
    const { a, b } = feed(400);
    const r = await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: strategy, venueFactory: () => new MockTradingVenue(),
    });
    for (let i = 1; i < r.windows.length; i++) {
      expect(r.windows[i].trainStart - r.windows[i - 1].trainStart).toBe(50);
    }
  });

  it('hands the strategy factory the window TRAIN slice (so β is fit OOS-safely)', async () => {
    const { a, b } = feed(300);
    const trainLens: number[] = [];
    await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: (ctx) => {
        trainLens.push(ctx.trainBarsA.length);
        expect(ctx.trainBarsA.length).toBe(ctx.trainBarsB.length);
        return strategy();
      },
      venueFactory: () => new MockTradingVenue(),
    });
    expect(trainLens.length).toBeGreaterThan(0);
    for (const len of trainLens) expect(len).toBe(100); // always the train slice, never the test slice
  });

  it('hands the venue factory the exact slice being run — train (W) then test (H) per window', async () => {
    const { a, b } = feed(250);
    const sliceLens: number[] = [];
    await walkForward({
      barsA: a, barsB: b, trainBars: 100, testBars: 50,
      strategyFactory: strategy,
      venueFactory: (ba, bb) => {
        expect(ba.length).toBe(bb.length);
        sliceLens.push(ba.length);
        return new MockTradingVenue();
      },
    });
    // Two venue builds per window: train slice (100) then test slice (50).
    expect(sliceLens.length % 2).toBe(0);
    for (let i = 0; i < sliceLens.length; i += 2) {
      expect(sliceLens[i]).toBe(100);
      expect(sliceLens[i + 1]).toBe(50);
    }
  });
});
