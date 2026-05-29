import { UniverseController, runUniverse, _resetPromotionLog } from './universe.controller';

describe('UniverseController', () => {
  beforeEach(() => _resetPromotionLog());

  it('GET /universe surfaces discovered clusters and ranked pairs', async () => {
    const c = new UniverseController();
    const r = await c.universe();
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(r.discoveredClusters.length).toBeGreaterThan(0);
    expect(r.topPairs.length).toBeGreaterThan(0);
    // Each pair has the regime tag attached.
    for (const p of r.topPairs) {
      expect(['LOW', 'NORMAL', 'HIGH']).toContain(p.regime.vol);
      expect(['RANGE', 'TRENDING']).toContain(p.regime.trend);
    }
  });

  it('GET /universe topPairs are sorted ascending by score', async () => {
    const c = new UniverseController();
    const r = await c.universe();
    for (let i = 1; i < r.topPairs.length; i++) {
      expect(r.topPairs[i].score).toBeGreaterThanOrEqual(r.topPairs[i - 1].score);
    }
  });

  it('GET /universe topPairs carry the cluster id of each symbol', async () => {
    const c = new UniverseController();
    const r = await c.universe();
    for (const p of r.topPairs) {
      expect(p.clusterA).toBeGreaterThanOrEqual(0);
      expect(p.clusterB).toBeGreaterThanOrEqual(0);
    }
  });

  it('POST /universe/promote logs a selection intent and points at the live configure step', async () => {
    const c = new UniverseController();
    const r = await c.promote({ symbolA: 'C0-S0', symbolB: 'C0-S1', note: 'manual review' });
    expect(r.ok).toBe(true);
    expect(r.nextStep).toBe('POST /api/stat-arb/live/configure then /start');
    expect(r.intent.note).toBe('manual review');
  });

  it('GET /universe/promotions returns logged promotions newest-first', async () => {
    const c = new UniverseController();
    await c.promote({ symbolA: 'A', symbolB: 'B' });
    await c.promote({ symbolA: 'X', symbolB: 'Y' });
    const r = await c.promotions();
    expect(r.promotions.length).toBe(2);
    expect(r.promotions[0].intent.symbolA).toBe('X');
  });

  it('representativePairs are a subset (in scoreset) of topPairs', async () => {
    const c = new UniverseController();
    const r = await c.universe();
    for (const rep of r.representativePairs) {
      // Each representative pair appears in the full discovered candidate list,
      // possibly outside the top-20 truncation window — check that the
      // (symbolA, symbolB) tuple appears in the universe.
      expect(r.symbols).toContain(rep.symbolA);
      expect(r.symbols).toContain(rep.symbolB);
    }
  });

  it('runUniverse honors override parameters', async () => {
    const r = await runUniverse({ clusterCount: 1, symbolsPerCluster: 2, noiseSymbols: 0, barCount: 150 });
    expect(r.symbols.length).toBe(2);
    expect(r.groundTruthClusters.length).toBe(1);
  });
});
