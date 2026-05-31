import { StrategyRegistry, strategyRegistry, RISK_PROFILES } from './strategy-registry';

describe('StrategyRegistry', () => {
  // The catalogue grows daily (quant desk adds/ships strategies — see
  // docs/QUANT_ROLE.md), so we assert STRUCTURE, not an exact list: the core
  // ids are present, every entry has the required shape and a unique id, and
  // both founding families are represented. New registry entries must not break
  // this test — that's the point.
  it('catalogues live-capable strategies across the cointegration + OU families', () => {
    const live = strategyRegistry.liveCapable();
    const ids = live.map((d) => d.id);
    // Founding strategies that other code/docs reference by id.
    for (const core of ['pairs-zscore', 'pairs-ewma', 'ou-bertram']) expect(ids).toContain(core);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    expect(live.length).toBeGreaterThanOrEqual(4);
    const families = new Set(live.map((d) => d.family));
    expect(families.has('cointegration')).toBe(true);
    expect(families.has('ou')).toBe(true);
    // Every entry is well-formed for the UI + deploy path.
    for (const d of live) {
      expect(d.id && d.label && d.courseRef).toBeTruthy();
      expect(typeof d.defaultParams).toBe('object');
      expect(['conservative', 'balanced', 'aggressive']).toContain(d.defaultRiskProfile);
    }
  });

  it('builds a usable, FLAT strategy carrying the supplied β for every catalogue id', () => {
    for (const def of strategyRegistry.liveCapable()) {
      const strat = strategyRegistry.build(def.id, { beta: 1.7, notionalUnits: 2_000_000n });
      expect(typeof strat.onBar).toBe('function');
      expect(strat.currentRegime()).toBe('FLAT');
      expect(strat.currentBeta()).toBe(1.7);
    }
  });

  it('rejects unknown ids and duplicate registration', () => {
    expect(() => strategyRegistry.build('nope', { beta: 1, notionalUnits: 1n })).toThrow(/unknown strategy/);
    const r = new StrategyRegistry();
    expect(() => r.register(r.all()[0])).toThrow(/duplicate/);
  });

  it('exposes three risk profiles ordered by aggression', () => {
    expect(RISK_PROFILES.conservative.maxDrawdownPct).toBeLessThan(RISK_PROFILES.balanced.maxDrawdownPct);
    expect(RISK_PROFILES.balanced.maxDrawdownPct).toBeLessThan(RISK_PROFILES.aggressive.maxDrawdownPct);
    expect(RISK_PROFILES.conservative.notionalFraction).toBeLessThan(RISK_PROFILES.aggressive.notionalFraction);
  });
});
