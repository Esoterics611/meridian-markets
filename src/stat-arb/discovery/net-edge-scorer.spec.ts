import { scoreNetEdge, barsPerDayForInterval } from './net-edge-scorer';

const base = { entryZ: 2, exitZ: 0.5, feeBps: 5, barsPerDay: 1440, minEdgeMultiple: 1.5, roundTripFactor: 2 };

describe('scoreNetEdge', () => {
  it('clears the fee gate and scores positive when σ_spread is healthy', () => {
    const s = scoreNetEdge({ ...base, sigmaSpread: 0.02, halfLifeBars: 10, pValue: 0.01 });
    expect(s.clearsFees).toBe(true);
    expect(s.perTradeNetEdgeBps).toBeGreaterThan(0);
    expect(s.netEdgePerDayBps).toBeGreaterThan(0);
    expect(s.certainty).toBeCloseTo(0.99, 5);
  });

  it('fails the gate and scores zero/day when the edge is sub-fee', () => {
    const s = scoreNetEdge({ ...base, sigmaSpread: 0.0005, halfLifeBars: 10, pValue: 0.01 });
    expect(s.clearsFees).toBe(false);
    expect(s.perTradeNetEdgeBps).toBeLessThan(0);
    expect(s.netEdgePerDayBps).toBe(0);
  });

  it('trades more often as the half-life shortens', () => {
    const fast = scoreNetEdge({ ...base, sigmaSpread: 0.02, halfLifeBars: 5, pValue: 0.01 });
    const slow = scoreNetEdge({ ...base, sigmaSpread: 0.02, halfLifeBars: 40, pValue: 0.01 });
    expect(fast.tradesPerDay).toBeGreaterThan(slow.tradesPerDay);
    expect(fast.netEdgePerDayBps).toBeGreaterThan(slow.netEdgePerDayBps);
  });

  it('lower confidence (higher pValue) discounts the score', () => {
    const confident = scoreNetEdge({ ...base, sigmaSpread: 0.02, halfLifeBars: 10, pValue: 0.01 });
    const shaky = scoreNetEdge({ ...base, sigmaSpread: 0.02, halfLifeBars: 10, pValue: 0.4 });
    expect(shaky.netEdgePerDayBps).toBeLessThan(confident.netEdgePerDayBps);
  });
});

describe('barsPerDayForInterval', () => {
  it('maps common Binance intervals', () => {
    expect(barsPerDayForInterval('1m')).toBe(1440);
    expect(barsPerDayForInterval('5m')).toBe(288);
    expect(barsPerDayForInterval('1h')).toBe(24);
    expect(barsPerDayForInterval('1d')).toBe(1);
  });
});
