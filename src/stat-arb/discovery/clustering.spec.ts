import { clusterSymbols, pickRepresentativePairs, pearson } from './clustering';
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

describe('clusterSymbols', () => {
  it('rediscovers ground-truth clusters at a loose threshold', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    // Two cluster groups (each of 3 cointegrated symbols) should land in two
    // single-cluster buckets; the 3 noise symbols may each form their own.
    const clusterBuckets = r.clusters.filter((c) => c.symbols.length >= 3);
    expect(clusterBuckets.length).toBe(2);
  });

  it('assigns every symbol to a cluster', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    for (const s of u.bars.keys()) expect(r.symbolToCluster.has(s)).toBe(true);
  });

  it('places cluster-C0 symbols together', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    const s0 = clusterSymbolName(0, 0);
    const s1 = clusterSymbolName(0, 1);
    const s2 = clusterSymbolName(0, 2);
    const cid = r.symbolToCluster.get(s0);
    expect(r.symbolToCluster.get(s1)).toBe(cid);
    expect(r.symbolToCluster.get(s2)).toBe(cid);
  });

  it('separates noise symbols from cluster symbols at a tight threshold', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.2 });
    const clusterCid = r.symbolToCluster.get(clusterSymbolName(0, 0));
    const noiseCid = r.symbolToCluster.get(noiseSymbolName(0));
    expect(clusterCid).not.toBe(noiseCid);
  });

  it('nominates a representative from inside the cluster', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    for (const c of r.clusters) {
      expect(c.symbols).toContain(c.representative);
    }
  });

  it('single-symbol cluster nominates itself', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.001 });
    for (const c of r.clusters) {
      if (c.symbols.length === 1) expect(c.representative).toBe(c.symbols[0]);
    }
  });

  it('every cluster has a unique clusterId', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    const ids = new Set(r.clusters.map((c) => c.clusterId));
    expect(ids.size).toBe(r.clusters.length);
  });

  it('empty universe returns no clusters', () => {
    const r = clusterSymbols(new Map(), { distanceThreshold: 0.4 });
    expect(r.clusters).toEqual([]);
  });
});

describe('pickRepresentativePairs', () => {
  it('reduces a candidate list to one pair per (clusterA, clusterB) bucket', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.30 });
    const reps = pickRepresentativePairs(cands, r.symbolToCluster);
    // Bucket count = unique (clusterA, clusterB) pairs. Must be <= cands.
    expect(reps.length).toBeLessThanOrEqual(cands.length);
    const buckets = new Set(reps.map((c) => {
      const ca = r.symbolToCluster.get(c.symbolA)!;
      const cb = r.symbolToCluster.get(c.symbolB)!;
      return ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    }));
    expect(buckets.size).toBe(reps.length);
  });

  it('keeps the lowest-score pair per bucket', () => {
    const u = uni();
    const r = clusterSymbols(u.bars, { distanceThreshold: 0.4 });
    const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.30 });
    const reps = pickRepresentativePairs(cands, r.symbolToCluster);
    for (const rep of reps) {
      const ca = r.symbolToCluster.get(rep.symbolA)!;
      const cb = r.symbolToCluster.get(rep.symbolB)!;
      const sameBucket = cands.filter((c) => {
        const aa = r.symbolToCluster.get(c.symbolA);
        const bb = r.symbolToCluster.get(c.symbolB);
        const k1 = aa! < bb! ? `${aa}|${bb}` : `${bb}|${aa}`;
        const k2 = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
        return k1 === k2;
      });
      expect(rep.score).toBeLessThanOrEqual(Math.min(...sameBucket.map((c) => c.score)));
    }
  });
});

describe('pearson', () => {
  it('perfectly correlated series returns 1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1.0, 6);
  });
  it('perfectly anti-correlated series returns -1', () => {
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1.0, 6);
  });
  it('constant input returns 0', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
});
