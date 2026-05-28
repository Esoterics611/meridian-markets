import { detectSignalDecay } from './signal-decay';

describe('detectSignalDecay', () => {
  it('returns NaN sharpes when the trade count is below window size', () => {
    const r = detectSignalDecay([1, 2, 3], { windowTrades: 10, decayRatio: 0.5 });
    expect(Number.isNaN(r.recentSharpe)).toBe(true);
    expect(r.decayed).toBe(false);
  });

  it('throws when windowTrades < 3', () => {
    expect(() => detectSignalDecay([1, 2, 3], { windowTrades: 2, decayRatio: 0.5 })).toThrow();
  });

  it('flat-positive recent vs flat-positive baseline → no decay', () => {
    const pnl = Array.from({ length: 40 }, () => 1.0);
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5 });
    expect(r.decayed).toBe(false);
  });

  it('strong baseline, weak recent window → decay flag fires', () => {
    // First 30 trades alternate +2 / +1 (positive mean, low variance, high
    // Sharpe). Last 10 trades alternate -0.5 / +0.5 (mean 0). Recent /
    // baseline → 0 / large positive → decay.
    const pnl: number[] = [];
    for (let i = 0; i < 30; i++) pnl.push(i % 2 === 0 ? 2 : 1);
    for (let i = 0; i < 10; i++) pnl.push(i % 2 === 0 ? -0.5 : 0.5);
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5 });
    expect(r.decayed).toBe(true);
    expect(r.recentSharpe).toBeLessThan(r.baselineSharpe);
  });

  it('baseline negative, recent flat-loss → decay (Sharpe deteriorates within negative range)', () => {
    // Earlier window: alternating -1/-2 → mean -1.5, std 0.5 → Sharpe ≈ -3.
    // Recent window: alternating -3/-2 → mean -2.5, std 0.5 → Sharpe ≈ -5
    // (more negative). Negative-baseline branch fires.
    const pnl: number[] = [];
    for (let i = 0; i < 30; i++) pnl.push(i % 2 === 0 ? -1 : -2);
    for (let i = 0; i < 10; i++) pnl.push(i % 2 === 0 ? -3 : -2);
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5 });
    expect(r.decayed).toBe(true);
  });

  it('baseline near zero (below floor) → treats baseline as zero → no decay', () => {
    // Median rolling Sharpe is around 0 → effective baseline = 0 → decay can't fire.
    const pnl = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5 });
    expect(r.decayed).toBe(false);
  });

  it('decayRatio tunes sensitivity', () => {
    const pnl: number[] = [];
    for (let i = 0; i < 30; i++) pnl.push(i % 2 === 0 ? 2 : 1);
    // Last 10 are weaker (mean 0.4) — decayRatio=0.9 fires, decayRatio=0.05 does not.
    for (let i = 0; i < 10; i++) pnl.push(i % 2 === 0 ? 0.6 : 0.2);
    const strict = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.9 });
    const loose = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.05 });
    expect(strict.decayed).toBe(true);
    expect(loose.decayed).toBe(false);
  });

  it('reports tradeCount', () => {
    const r = detectSignalDecay([1, 2, 3, 4, 5], { windowTrades: 3, decayRatio: 0.5 });
    expect(r.tradeCount).toBe(5);
  });

  it('zero-variance recent window → recentSharpe = 0', () => {
    const pnl: number[] = [];
    for (let i = 0; i < 30; i++) pnl.push(i % 2 === 0 ? 2 : 1);
    for (let i = 0; i < 10; i++) pnl.push(0.0);
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5 });
    expect(r.recentSharpe).toBe(0);
  });

  it('respects a custom minBaselineSharpe floor', () => {
    // With a high baseline floor, a moderate baseline gets treated as zero.
    const pnl: number[] = [];
    for (let i = 0; i < 30; i++) pnl.push(i % 2 === 0 ? 1.2 : 0.8);
    for (let i = 0; i < 10; i++) pnl.push(i % 2 === 0 ? 0.5 : 0.3);
    const r = detectSignalDecay(pnl, { windowTrades: 10, decayRatio: 0.5, minBaselineSharpe: 100 });
    // Baseline is effectively 0 → can't decay below zero → no flag.
    expect(r.decayed).toBe(false);
  });
});
