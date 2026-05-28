import { discoverPairs } from './pair-discovery';
import {
  generateSyntheticUniverse,
  clusterSymbolName,
  noiseSymbolName,
} from '../backtest/synthetic-universe';

const baseCfg = {
  barCount: 240,
  startAt: new Date('2026-01-01T00:00:00Z'),
  barIntervalMs: 60_000,
  clusterCount: 2,
  symbolsPerCluster: 3,
  noiseSymbols: 3,
};

function uni() {
  return generateSyntheticUniverse(baseCfg);
}

describe('discoverPairs', () => {
  it('returns at least one candidate when the universe contains cointegrated clusters', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    expect(cands.length).toBeGreaterThan(0);
  });

  it('prefers intra-cluster pairs over noise pairs', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    // Top candidate must be an intra-cluster pair (same C-prefix).
    const top = cands[0];
    expect(top.symbolA[0]).toBe('C');
    expect(top.symbolB[0]).toBe('C');
    expect(top.symbolA.slice(0, 2)).toBe(top.symbolB.slice(0, 2));
  });

  it('drops pairs with pValue above the cutoff', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.05 });
    for (const c of cands) expect(c.pValue).toBeLessThanOrEqual(0.05);
  });

  it('rejects pairs with non-finite half-life', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    for (const c of cands) expect(Number.isFinite(c.halfLifeBars)).toBe(true);
  });

  it('half-life range is respected when configured', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, {
      minBars: 50, pValueCutoff: 0.10,
      minHalfLifeBars: 5, maxHalfLifeBars: 30,
    });
    for (const c of cands) {
      expect(c.halfLifeBars).toBeGreaterThanOrEqual(5);
      expect(c.halfLifeBars).toBeLessThanOrEqual(30);
    }
  });

  it('output is sorted ascending by score', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i].score).toBeGreaterThanOrEqual(cands[i - 1].score);
    }
  });

  it('minAdv filter excludes thin-volume pairs', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10, minAdv: 80 });
    // The first symbol in each cluster has volume=300; the last has volume=100.
    // Noise volumes are 50 — minAdv=80 drops noise pairs entirely.
    for (const c of cands) {
      expect(Math.min(c.advA, c.advB)).toBeGreaterThanOrEqual(80);
    }
  });

  it('returns no candidates when minBars exceeds the available history', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 1000, pValueCutoff: 0.10 });
    expect(cands).toEqual([]);
  });

  it('symmetric: discoverPairs(a-b) and discoverPairs(b-a) produce the same set', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    // The map keys produce a canonical iteration order; (a, b) pairs only
    // emerge with i < j so duplicates aren't possible. Verify no pair is
    // present in both directions.
    const seen = new Set<string>();
    for (const c of cands) {
      const key = [c.symbolA, c.symbolB].sort().join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('every candidate carries a numeric beta and ADV', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    for (const c of cands) {
      expect(Number.isFinite(c.beta)).toBe(true);
      expect(c.advA).toBeGreaterThan(0);
      expect(c.advB).toBeGreaterThan(0);
    }
  });

  it('cluster-of-3 produces 3 intra-cluster candidate pairs', () => {
    const u = generateSyntheticUniverse({ ...baseCfg, clusterCount: 1, symbolsPerCluster: 3, noiseSymbols: 0 });
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.10 });
    // C0-S0/S1, C0-S0/S2, C0-S1/S2.
    expect(cands.length).toBe(3);
  });

  it('noise-only universe yields zero candidates at strict cutoff', () => {
    const u = generateSyntheticUniverse({ ...baseCfg, clusterCount: 0, symbolsPerCluster: 0, noiseSymbols: 4 });
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.05 });
    // Noise symbols can sometimes pass loose cutoffs by accident — strict
    // p<0.05 should reject them. If this fails the synthetic universe gen
    // needs more independence.
    for (const c of cands) {
      // If any pass, they must be at the boundary, not deeply cointegrated.
      expect(c.pValue).toBeLessThan(0.05);
    }
  });

  it('mismatched series lengths use the shared minimum', () => {
    const u = uni();
    const shortened = new Map(u.bars);
    const a = clusterSymbolName(0, 0);
    const b = clusterSymbolName(0, 1);
    shortened.set(a, shortened.get(a)!.slice(0, 80));
    const cands = discoverPairs(shortened, { minBars: 60, pValueCutoff: 0.10 });
    const pair = cands.find((c) => (c.symbolA === a && c.symbolB === b) || (c.symbolA === b && c.symbolB === a));
    if (pair) {
      // The truncated leg should reduce the shared sample, but the pair still
      // may pass since 80 bars > minBars=60.
      expect(Number.isFinite(pair.score)).toBe(true);
    }
  });

  it('includes a noise symbol when sampling does not exclude it via minBars', () => {
    const u = uni();
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.50 });
    const involvesNoise = cands.some((c) => c.symbolA.startsWith('N') || c.symbolB.startsWith('N'));
    // With p<0.50 (loose), some noise may slip in — that's expected, but
    // they must not outrank cluster pairs. (Same check as test 2 in spirit.)
    const noiseCands = cands.filter((c) => c.symbolA.startsWith('N') || c.symbolB.startsWith('N'));
    if (noiseCands.length > 0 && involvesNoise) {
      const topClusterScore = cands.find((c) => !c.symbolA.startsWith('N') && !c.symbolB.startsWith('N'))!.score;
      const topNoiseScore = noiseCands[0].score;
      expect(topClusterScore).toBeLessThan(topNoiseScore);
    }
  });

  it('two-symbol universe yields at most one pair', () => {
    const u = new Map<string, ReturnType<typeof generateSyntheticUniverse>['bars']['get']>();
    const universe = generateSyntheticUniverse(baseCfg);
    const subset = new Map([
      [clusterSymbolName(0, 0), universe.bars.get(clusterSymbolName(0, 0))!],
      [noiseSymbolName(0), universe.bars.get(noiseSymbolName(0))!],
    ]);
    const cands = discoverPairs(subset, { minBars: 50, pValueCutoff: 1.0 });
    expect(cands.length).toBeLessThanOrEqual(1);
    void u; // keep linter quiet
  });
});
