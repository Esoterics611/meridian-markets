import { allocateUniverse, AllocationCandidate, AllocatorConfig } from './regime-universe-allocator';

const cand = (symbol: string, side: -1 | 0 | 1, conviction: number, ic = conviction / 4): AllocationCandidate => ({ symbol, side, conviction, ic });

const baseCfg: AllocatorConfig = { topN: 3, baseNotionalUsd: 50_000, maxGrossUsd: 200_000, maxNetUsd: 100_000 };

describe('RegimeUniverseAllocator (P12)', () => {
  it('selects the top-N by conviction and sizes notional = base·conviction', () => {
    const r = allocateUniverse(
      [cand('A', 1, 0.4), cand('B', -1, 0.2), cand('C', 1, 0.1), cand('D', 1, 0.05)],
      { ...baseCfg, topN: 2 },
    );
    expect(r.allocations.map((a) => a.symbol)).toEqual(['A', 'B']);
    expect(r.allocations[0].notionalUsd).toBeCloseTo(50_000 * 0.4, 2); // 20,000
    expect(r.allocations[1].notionalUsd).toBeCloseTo(50_000 * 0.2, 2); // 10,000
    expect(r.excluded).toEqual(expect.arrayContaining(['C', 'D']));
  });

  it('drops flat / zero-conviction candidates', () => {
    const r = allocateUniverse([cand('A', 0, 0.9), cand('B', 1, 0), cand('C', 1, 0.3)], baseCfg);
    expect(r.allocations.map((a) => a.symbol)).toEqual(['C']);
    expect(r.excluded).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('caps each book at the per-symbol max', () => {
    const r = allocateUniverse([cand('A', 1, 1.0)], { ...baseCfg, perSymbolMaxUsd: 30_000 });
    expect(r.allocations[0].notionalUsd).toBe(30_000); // 50k·1.0 capped to 30k
    expect(r.allocations[0].reason).toContain('per-symbol cap');
  });

  it('TRIMS to the gross cap (never breaches)', () => {
    // 4 names at full conviction → 4·50k = 200k raw; gross cap 120k ⇒ scale by 0.6.
    const r = allocateUniverse(
      [cand('A', 1, 1), cand('B', 1, 1), cand('C', -1, 1), cand('D', -1, 1)],
      { topN: 4, baseNotionalUsd: 50_000, maxGrossUsd: 120_000, maxNetUsd: 1_000_000 },
    );
    expect(r.grossUsd).toBeLessThanOrEqual(120_000 + 0.01);
    expect(r.grossUsd).toBeCloseTo(120_000, 0);
    expect(r.grossCapBound).toBe(true);
    for (const a of r.allocations) expect(a.notionalUsd).toBeCloseTo(30_000, 0); // 50k·0.6
  });

  it('TRIMS the heavier side to the net cap (never breaches)', () => {
    // 3 longs (150k) + 1 short (50k) ⇒ net +100k; cap net at 40k ⇒ reduce longs by 60k pro-rata.
    const r = allocateUniverse(
      [cand('A', 1, 1), cand('B', 1, 1), cand('C', 1, 1), cand('D', -1, 1)],
      { topN: 4, baseNotionalUsd: 50_000, maxGrossUsd: 1_000_000, maxNetUsd: 40_000 },
    );
    expect(Math.abs(r.netUsd)).toBeLessThanOrEqual(40_000 + 0.05);
    expect(r.netCapBound).toBe(true);
    // shorts untouched, longs each reduced from 50k to 30k (60k of excess / 3 longs).
    const short = r.allocations.find((a) => a.symbol === 'D')!;
    expect(short.notionalUsd).toBeCloseTo(50_000, 0);
  });

  it('respects ALL caps simultaneously and never breaches either', () => {
    const r = allocateUniverse(
      [cand('A', 1, 0.9), cand('B', 1, 0.8), cand('C', -1, 0.7), cand('D', -1, 0.6), cand('E', 1, 0.5)],
      { topN: 5, baseNotionalUsd: 100_000, perSymbolMaxUsd: 80_000, maxGrossUsd: 250_000, maxNetUsd: 60_000 },
    );
    expect(r.grossUsd).toBeLessThanOrEqual(250_000 + 0.05);
    expect(Math.abs(r.netUsd)).toBeLessThanOrEqual(60_000 + 0.05);
    for (const a of r.allocations) expect(a.notionalUsd).toBeLessThanOrEqual(80_000 + 0.05);
  });

  it('returns an empty allocation when nothing is fundable', () => {
    const r = allocateUniverse([cand('A', 0, 0.5), cand('B', 1, 0)], baseCfg);
    expect(r.allocations).toHaveLength(0);
    expect(r.grossUsd).toBe(0);
    expect(r.netUsd).toBe(0);
  });
});
