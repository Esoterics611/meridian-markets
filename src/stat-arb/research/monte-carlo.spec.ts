import { monteCarlo } from './monte-carlo';
import { TradeRecord } from '../backtest/backtest-runner';

function trade(pnl: bigint, idx = 0): TradeRecord {
  return {
    openIndex: idx, closeIndex: idx + 1, side: 'SHORT',
    entryZ: 1.5, exitZ: 0.2, pnlUnits: pnl, holdBars: 1,
  };
}

describe('monteCarlo', () => {
  it('produces p05 / p50 / p95 arrays of the same length as the input trades', () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade(BigInt((i % 3 === 0 ? -1 : 1) * 100), i));
    const r = monteCarlo({ trades, replications: 200, seed: 1 });
    expect(r.p05.length).toBe(20);
    expect(r.p50.length).toBe(20);
    expect(r.p95.length).toBe(20);
  });

  it('p05 <= p50 <= p95 at every step', () => {
    const trades = Array.from({ length: 30 }, (_, i) => trade(BigInt((i % 2 === 0 ? -1 : 1) * 200), i));
    const r = monteCarlo({ trades, replications: 200, seed: 7 });
    for (let i = 0; i < r.p05.length; i++) {
      expect(r.p05[i]).toBeLessThanOrEqual(r.p50[i]);
      expect(r.p50[i]).toBeLessThanOrEqual(r.p95[i]);
    }
  });

  it('is deterministic for a given seed', () => {
    const trades = [trade(100n, 0), trade(-50n, 1), trade(200n, 2), trade(-25n, 3)];
    const a = monteCarlo({ trades, replications: 100, seed: 99 });
    const b = monteCarlo({ trades, replications: 100, seed: 99 });
    expect(a.summary.meanFinalPnl).toBe(b.summary.meanFinalPnl);
    expect(a.p50).toEqual(b.p50);
  });

  it('different seeds produce different outputs', () => {
    // Use a longer, more varied trade series so the bootstrap sample space is
    // large enough that two seeds will plausibly disagree on the p50.
    const trades = Array.from({ length: 30 }, (_, i) =>
      trade(BigInt(((i * 37) % 11) - 5) * 100n, i),
    );
    const a = monteCarlo({ trades, replications: 200, seed: 1 });
    const b = monteCarlo({ trades, replications: 200, seed: 12345 });
    expect(a.p50).not.toEqual(b.p50);
  });

  it('returns the empty report when no trades are supplied', () => {
    const r = monteCarlo({ trades: [], replications: 100, seed: 1 });
    expect(r.p05).toEqual([]);
    expect(r.summary.meanFinalPnl).toBe(0);
    expect(r.summary.probPositive).toBe(0);
  });

  it('throws when replications < 1', () => {
    expect(() => monteCarlo({ trades: [trade(100n)], replications: 0, seed: 1 })).toThrow();
  });

  it('all-positive trades yield probPositive ≈ 1', () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade(100n, i));
    const r = monteCarlo({ trades, replications: 200, seed: 5 });
    expect(r.summary.probPositive).toBe(1);
    expect(r.summary.medianFinalPnl).toBeGreaterThan(0);
  });

  it('all-negative trades yield probPositive = 0', () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade(-100n, i));
    const r = monteCarlo({ trades, replications: 200, seed: 5 });
    expect(r.summary.probPositive).toBe(0);
    expect(r.summary.medianFinalPnl).toBeLessThan(0);
  });

  it('the median final P&L is approximately the empirical-mean × N for mixed trades', () => {
    // Bootstrap-resampling from a series with mean 50, length N, will have a
    // sampling distribution whose median is near mean*N = 50*30 = 1500.
    const trades = Array.from({ length: 30 }, (_, i) => trade(BigInt(i % 2 === 0 ? 100 : 0), i));
    const r = monteCarlo({ trades, replications: 500, seed: 11 });
    expect(r.summary.medianFinalPnl).toBeGreaterThan(1000);
    expect(r.summary.medianFinalPnl).toBeLessThan(2000);
  });
});
