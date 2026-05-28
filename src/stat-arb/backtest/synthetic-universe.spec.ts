import {
  generateSyntheticUniverse,
  clusterSymbolName,
  noiseSymbolName,
} from './synthetic-universe';

const baseCfg = {
  barCount: 100,
  startAt: new Date('2026-01-01T00:00:00Z'),
  barIntervalMs: 60_000,
  clusterCount: 2,
  symbolsPerCluster: 3,
  noiseSymbols: 2,
};

describe('generateSyntheticUniverse', () => {
  it('produces clusters of the requested size', () => {
    const u = generateSyntheticUniverse(baseCfg);
    expect(u.clusters.length).toBe(2);
    for (const c of u.clusters) expect(c.symbols.length).toBe(3);
  });

  it('produces the requested noise count', () => {
    const u = generateSyntheticUniverse(baseCfg);
    expect(u.noiseSymbols.length).toBe(2);
  });

  it('total symbol count is clusters*symbolsPerCluster + noise', () => {
    const u = generateSyntheticUniverse(baseCfg);
    expect(u.bars.size).toBe(2 * 3 + 2);
  });

  it('each symbol has the requested bar count', () => {
    const u = generateSyntheticUniverse(baseCfg);
    for (const [, bars] of u.bars) expect(bars.length).toBe(100);
  });

  it('symbol names follow Cx-Sy / Nx convention', () => {
    const u = generateSyntheticUniverse(baseCfg);
    expect([...u.bars.keys()]).toContain(clusterSymbolName(0, 0));
    expect([...u.bars.keys()]).toContain(clusterSymbolName(1, 2));
    expect([...u.bars.keys()]).toContain(noiseSymbolName(0));
  });

  it('cluster symbols co-move (correlated log-prices)', () => {
    const u = generateSyntheticUniverse({ ...baseCfg, barCount: 200 });
    const a = u.bars.get(clusterSymbolName(0, 0))!.map((b) => Math.log(b.close));
    const b = u.bars.get(clusterSymbolName(0, 1))!.map((b) => Math.log(b.close));
    expect(pearson(a, b)).toBeGreaterThan(0.8);
  });

  it('cluster and noise symbols are weakly correlated', () => {
    const u = generateSyntheticUniverse({ ...baseCfg, barCount: 200 });
    const a = u.bars.get(clusterSymbolName(0, 0))!.map((b) => Math.log(b.close));
    const n = u.bars.get(noiseSymbolName(0))!.map((b) => Math.log(b.close));
    expect(Math.abs(pearson(a, n))).toBeLessThan(0.7);
  });

  it('volume decreases per intra-cluster index (first symbol looks most liquid)', () => {
    const u = generateSyntheticUniverse(baseCfg);
    const v0 = u.bars.get(clusterSymbolName(0, 0))![0].volume;
    const v1 = u.bars.get(clusterSymbolName(0, 1))![0].volume;
    expect(v0).toBeGreaterThan(v1);
  });

  it('two runs with the same config produce byte-identical bars', () => {
    const a = generateSyntheticUniverse(baseCfg);
    const b = generateSyntheticUniverse(baseCfg);
    const k = clusterSymbolName(0, 0);
    expect(a.bars.get(k)![50].close).toBe(b.bars.get(k)![50].close);
  });

  it('bar timestamps are monotonic', () => {
    const u = generateSyntheticUniverse(baseCfg);
    const bars = u.bars.get(clusterSymbolName(0, 0))!;
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].timestamp.getTime()).toBeGreaterThan(bars[i - 1].timestamp.getTime());
    }
  });
});

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[i] - ma, bx = b[i] - mb;
    num += ax * bx;
    da += ax * ax;
    db += bx * bx;
  }
  return num / Math.sqrt(da * db);
}
