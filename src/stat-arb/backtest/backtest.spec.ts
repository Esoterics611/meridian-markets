import { MockTradingVenue } from '../mock-trading-venue';
import { BacktestRunner } from './backtest-runner';
import { PairsStrategy } from './pairs-strategy';
import { generateSyntheticFeed } from './synthetic-feed';

function makeRunSetup() {
  const { a, b } = generateSyntheticFeed({
    symbolA: 'BTC',
    symbolB: 'ETH',
    barCount: 200,
    spreadPeriodBars: 30,
    spreadAmplitude: 0.05,
    basePriceB: 2000,
    aOverBRatio: 25,
    barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
  const strategy = new PairsStrategy({
    beta: 1,
    zLookback: 20,
    entryZ: 1.2,
    exitZ: 0.3,
    notionalUnits: 1_000_000n,
  });
  // Use a fixed-clock venue so fees and timestamps are deterministic.
  const venue = new MockTradingVenue(5n, () => new Date('2026-02-01T00:00:00Z'));
  return { a, b, strategy, venue };
}

describe('BacktestRunner', () => {
  it('runs end-to-end on synthetic correlated series and produces trades', async () => {
    const { a, b, strategy, venue } = makeRunSetup();
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.metrics.totalTrades).toBe(result.trades.length);
  });

  it('produces a spreadSeries with one entry per bar', async () => {
    const { a, b, strategy, venue } = makeRunSetup();
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue });
    expect(result.spreadSeries.length).toBe(a.length);
  });

  it('every trade has nonnegative holdBars and pnlUnits is a bigint', async () => {
    const { a, b, strategy, venue } = makeRunSetup();
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue });
    for (const t of result.trades) {
      expect(t.holdBars).toBeGreaterThan(0);
      expect(typeof t.pnlUnits).toBe('bigint');
    }
  });

  it('metrics are populated and well-formed', async () => {
    const { a, b, strategy, venue } = makeRunSetup();
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue });
    expect(typeof result.metrics.totalPnlUnits).toBe('bigint');
    expect(Number.isFinite(result.metrics.sharpeRatio)).toBe(true);
    expect(Number.isFinite(result.metrics.maxDrawdownPct)).toBe(true);
    expect(result.metrics.winRate).toBeGreaterThanOrEqual(0);
    expect(result.metrics.winRate).toBeLessThanOrEqual(1);
  });

  it('throws when bar arrays have mismatched lengths', async () => {
    const { a, b, strategy, venue } = makeRunSetup();
    await expect(
      new BacktestRunner().run({ barsA: a, barsB: b.slice(0, 100), strategy, venue }),
    ).rejects.toThrow(/same length/);
  });

  it('two strategies on the same feed produce the same trade count (no lookahead)', async () => {
    const s1 = makeRunSetup();
    const s2 = makeRunSetup();
    const r1 = await new BacktestRunner().run({ barsA: s1.a, barsB: s1.b, strategy: s1.strategy, venue: s1.venue });
    const r2 = await new BacktestRunner().run({ barsA: s2.a, barsB: s2.b, strategy: s2.strategy, venue: s2.venue });
    expect(r1.trades.length).toBe(r2.trades.length);
    for (let i = 0; i < r1.trades.length; i++) {
      expect(r1.trades[i].openIndex).toBe(r2.trades[i].openIndex);
      expect(r1.trades[i].closeIndex).toBe(r2.trades[i].closeIndex);
      expect(r1.trades[i].side).toBe(r2.trades[i].side);
    }
  });

  it('the strategy never sees future bars (history length ≤ index+1)', async () => {
    const { a, b, venue } = makeRunSetup();
    let maxSeen = 0;
    const observingStrategy = new (class extends PairsStrategy {
      override onBar(ctx: Parameters<PairsStrategy['onBar']>[0]) {
        if (ctx.historyA.length > ctx.index + 1) {
          throw new Error(`lookahead! history=${ctx.historyA.length} index=${ctx.index}`);
        }
        if (ctx.historyA.length > maxSeen) maxSeen = ctx.historyA.length;
        return super.onBar(ctx);
      }
    })({
      beta: 1,
      zLookback: 20,
      entryZ: 1.2,
      exitZ: 0.3,
      notionalUnits: 1_000_000n,
    });
    await new BacktestRunner().run({ barsA: a, barsB: b, strategy: observingStrategy, venue });
    expect(maxSeen).toBe(a.length);
  });

  it('with extreme entry threshold (entryZ huge) there are zero trades', async () => {
    const { a, b, venue } = makeRunSetup();
    const strategy = new PairsStrategy({
      beta: 1,
      zLookback: 20,
      entryZ: 99,
      exitZ: 0.3,
      notionalUnits: 1_000_000n,
    });
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue });
    expect(result.trades.length).toBe(0);
    expect(result.metrics.totalTrades).toBe(0);
  });
});
