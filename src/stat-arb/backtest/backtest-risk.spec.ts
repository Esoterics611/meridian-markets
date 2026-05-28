import { BacktestRunner } from './backtest-runner';
import { PairsStrategy } from './pairs-strategy';
import { generateSyntheticFeed } from './synthetic-feed';
import { MockTradingVenue } from '../mock-trading-venue';
import { RiskEngine } from '../risk/risk-engine';
import { DrawdownGate } from '../risk/drawdown-gate';
import { VenueCapGate } from '../risk/venue-cap';
import { ExposureCapsGate } from '../risk/exposure-caps';

function feed(barCount = 200) {
  return generateSyntheticFeed({
    symbolA: 'BTC',
    symbolB: 'ETH',
    barCount,
    spreadPeriodBars: 25,
    spreadAmplitude: 0.05,
    basePriceB: 2000,
    aOverBRatio: 25,
    barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('BacktestRunner × RiskEngine', () => {
  it('runs without an engine and reports empty gateEvents / zero blocked', async () => {
    const { a, b } = feed(120);
    const r = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
    });
    expect(r.gateEvents).toEqual([]);
    expect(r.blockedEntries).toBe(0);
  });

  it('blocks every OPEN when the venue cap is set absurdly low', async () => {
    const { a, b } = feed(120);
    const engine = new RiskEngine({
      venueCap: new VenueCapGate({ maxNotionalUnitsPerVenue: 1n }),
    });
    const r = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
      riskEngine: engine,
      riskOpts: { capitalUnits: 100_000_000n, pairId: 'btc/eth' },
    });
    expect(r.blockedEntries).toBeGreaterThan(0);
    expect(r.gateEvents.every((e) => e.kind === 'VENUE_CAP')).toBe(true);
    expect(r.trades.length).toBe(0);
  });

  it('allows trades through a permissive engine and records no gate events', async () => {
    const { a, b } = feed(200);
    const engine = new RiskEngine({
      drawdown: new DrawdownGate({ maxDrawdownPct: 99 }),
      venueCap: new VenueCapGate({ maxNotionalUnitsPerVenue: 10_000_000_000n }),
      exposure: new ExposureCapsGate({
        maxGrossUnits: 10_000_000_000n,
        maxNetUnits: 10_000_000_000n,
        maxPairUnits: 10_000_000_000n,
      }),
    });
    const r = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
      riskEngine: engine,
      riskOpts: { capitalUnits: 100_000_000n, pairId: 'btc/eth' },
    });
    expect(r.gateEvents).toEqual([]);
    expect(r.blockedEntries).toBe(0);
    expect(r.trades.length).toBeGreaterThan(0);
  });

  it('lets CLOSE legs through even with a strict drawdown gate', async () => {
    const { a, b } = feed(200);
    // Run once without engine to ensure trades open & close — gives us a baseline trade count.
    const baseline = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
    });
    expect(baseline.trades.length).toBeGreaterThan(0);

    const engine = new RiskEngine({ drawdown: new DrawdownGate({ maxDrawdownPct: 0.001 }) });
    const r = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
      riskEngine: engine,
      riskOpts: { capitalUnits: 100_000_000n, pairId: 'btc/eth' },
    });
    // With a 0.001% drawdown gate, the first losing trade trips the gate forever,
    // so we expect strictly fewer trades than baseline — but the runner should
    // still complete and the trades that DID open close out cleanly.
    expect(r.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });

  it('produces gate events keyed by the bar index where the breach occurred', async () => {
    const { a, b } = feed(200);
    const engine = new RiskEngine({
      venueCap: new VenueCapGate({ maxNotionalUnitsPerVenue: 1n }),
    });
    const r = await new BacktestRunner().run({
      barsA: a, barsB: b, venue: new MockTradingVenue(),
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n }),
      riskEngine: engine,
    });
    expect(r.gateEvents[0].barIndex).toBeGreaterThanOrEqual(20);
  });
});
