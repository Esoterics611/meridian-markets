import { parameterSweep, rankBySharpe } from './parameter-sweep';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { MockTradingVenue } from '../mock-trading-venue';

function feed(barCount: number) {
  return generateSyntheticFeed({
    symbolA: 'BTC', symbolB: 'ETH',
    barCount, spreadPeriodBars: 25, spreadAmplitude: 0.05,
    basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
}

const baseConfig = { beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n };

describe('parameterSweep', () => {
  it('runs every cell of a 1-axis grid', async () => {
    const { a, b } = feed(150);
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      axes: [{ name: 'entryZ', values: [1.0, 1.2, 1.5, 2.0] }],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    });
    expect(cells.length).toBe(4);
    expect(cells.map(c => c.params.entryZ)).toEqual([1.0, 1.2, 1.5, 2.0]);
  });

  it('runs the Cartesian product of multi-axis grids', async () => {
    const { a, b } = feed(150);
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      axes: [
        { name: 'entryZ', values: [1.0, 1.5, 2.0] },
        { name: 'exitZ',  values: [0.0, 0.3, 0.5] },
      ],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    });
    expect(cells.length).toBe(9);
    // Every (entryZ, exitZ) pair is present exactly once.
    const keys = new Set(cells.map(c => `${c.params.entryZ}|${c.params.exitZ}`));
    expect(keys.size).toBe(9);
  });

  it('each cell carries totalPnlUnits + sharpeRatio + maxDrawdownPct + totalTrades', async () => {
    const { a, b } = feed(150);
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      axes: [{ name: 'entryZ', values: [1.0, 1.5] }],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    });
    for (const c of cells) {
      expect(typeof c.totalPnlUnits).toBe('bigint');
      expect(typeof c.sharpeRatio).toBe('number');
      expect(typeof c.maxDrawdownPct).toBe('number');
      expect(typeof c.totalTrades).toBe('number');
    }
  });

  it('different param values produce different trade counts on the synthetic feed', async () => {
    const { a, b } = feed(400);
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      // Spread an extreme entryZ that never triggers entries against a permissive one.
      axes: [{ name: 'entryZ', values: [0.5, 10.0] }],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    });
    const tradeCounts = cells.map(c => c.totalTrades);
    expect(new Set(tradeCounts).size).toBeGreaterThan(1);
  });

  it('rankBySharpe sorts descending', async () => {
    const { a, b } = feed(200);
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      axes: [{ name: 'entryZ', values: [1.0, 1.2, 1.5, 2.0] }],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    });
    const ranked = rankBySharpe(cells);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].sharpeRatio).toBeGreaterThanOrEqual(ranked[i].sharpeRatio);
    }
  });

  it('throws on empty axes array', async () => {
    const { a, b } = feed(100);
    await expect(parameterSweep({
      barsA: a, barsB: b, axes: [], baseConfig, venueFactory: () => new MockTradingVenue(),
    })).rejects.toThrow();
  });

  it('throws when an axis has no values', async () => {
    const { a, b } = feed(100);
    await expect(parameterSweep({
      barsA: a, barsB: b,
      axes: [{ name: 'entryZ', values: [] }],
      baseConfig, venueFactory: () => new MockTradingVenue(),
    })).rejects.toThrow();
  });
});
