import { purgedKFoldCv } from './cross-validate';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { MockTradingVenue } from '../mock-trading-venue';

function feed(barCount: number) {
  return generateSyntheticFeed({
    symbolA: 'AAA', symbolB: 'BBB', barCount,
    spreadPeriodBars: 25, spreadAmplitude: 0.05,
    basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function strat() {
  return new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 100_000_000_000n });
}

describe('purgedKFoldCv', () => {
  it('runs every fold and pools OOS trade P&Ls', async () => {
    const { a, b } = feed(500);
    const r = await purgedKFoldCv({
      barsA: a, barsB: b, folds: 5, embargoFrac: 0.01,
      strategyFactory: () => strat(),
      venueFactory: () => new MockTradingVenue(undefined, () => new Date('2026-03-01T00:00:00Z')),
    });
    expect(r.folds.length).toBe(5);
    expect(typeof r.avgTestSharpe).toBe('number');
    // Pooled OOS trades == sum of per-fold trade counts.
    const perFold = r.folds.reduce((s, f) => s + f.testTradePnlUnits.length, 0);
    expect(r.oosTradePnlUnits.length).toBe(perFold);
  });

  it('hands the strategy factory the purged train bars (smaller than n with embargo)', async () => {
    const { a, b } = feed(400);
    const trainSizes: number[] = [];
    await purgedKFoldCv({
      barsA: a, barsB: b, folds: 4, embargoFrac: 0.02,
      strategyFactory: (ta) => { trainSizes.push(ta.length); return strat(); },
      venueFactory: () => new MockTradingVenue(undefined, () => new Date('2026-03-01T00:00:00Z')),
    });
    // Each train set excludes its test fold plus the embargo, so < n.
    for (const size of trainSizes) expect(size).toBeLessThan(400);
    expect(trainSizes.length).toBe(4);
  });

  it('rejects mismatched bar lengths', async () => {
    const { a } = feed(100);
    const { b } = feed(80);
    await expect(purgedKFoldCv({
      barsA: a, barsB: b, folds: 4,
      strategyFactory: () => strat(),
      venueFactory: () => new MockTradingVenue(),
    })).rejects.toThrow(/same length/);
  });
});
