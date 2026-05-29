import { StrategyRegistry, strategyRegistry, RISK_PROFILES } from './strategy-registry';

describe('StrategyRegistry', () => {
  it('catalogues the live-capable strategies across the cointegration + OU families', () => {
    const ids = strategyRegistry.liveCapable().map((d) => d.id).sort();
    expect(ids).toEqual(['ou-bertram', 'ou-bertram-fast', 'pairs-ewma', 'pairs-zscore']);
    const families = new Set(strategyRegistry.liveCapable().map((d) => d.family));
    expect(families.has('cointegration')).toBe(true);
    expect(families.has('ou')).toBe(true);
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
