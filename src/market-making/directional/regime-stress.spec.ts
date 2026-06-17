import { runStressScenario, buildStressPath, STRESS_SCENARIOS, StressScenarioKind } from './regime-stress';

describe('regime-stress harness (P11)', () => {
  it('exposes the four canonical scenarios', () => {
    expect(STRESS_SCENARIOS).toEqual(['flash-crash', 'vol-spike', 'funding-flip', 'feed-blackout']);
  });

  describe('flash crash', () => {
    const r = runStressScenario('flash-crash', { symbols: ['BTC', 'ETH', 'SOL'] });
    it('NEVER breaches the maxDD budget without engaging the kill-switch', () => {
      // The headline invariant: a −15% gap is bigger than any one book's 2% stop, so either the
      // desk stayed inside budget OR the maxDD kill-switch HALTed. It must not breach silently.
      expect(r.budgetRespected).toBe(true);
    });
    it('fires the directional stop and HALTs the desk (a 3-book −15% gap is ~5% > 2% budget)', () => {
      expect(r.stopsFired).toBeGreaterThanOrEqual(1);
      expect(r.deskHalted).toBe(true);
      expect(r.maxDrawdownFrac).toBeGreaterThan(r.budgetFrac); // it DID breach…
      expect(r.flatAtEnd).toBe(true); // …and the desk flattened in response
    });
  });

  describe('vol spike', () => {
    const r = runStressScenario('vol-spike', { symbols: ['BTC', 'ETH', 'SOL'] });
    it('stands EVERY held book aside (the monitor flips to STAND_ASIDE on the spike)', () => {
      expect(r.allHeldStoodAside).toBe(true);
      expect(r.standAsideBooks).toBe(3);
    });
    it('keeps the desk inside budget (a vol spike is not a directional loss)', () => {
      expect(r.budgetRespected).toBe(true);
      expect(r.flatAtEnd).toBe(true);
    });
  });

  describe('funding flip', () => {
    const r = runStressScenario('funding-flip', { symbols: ['BTC', 'ETH'] });
    it('fires a regime-change transition (the funding side flips paid-short → paid-long)', () => {
      expect(r.regimeTransitions).toBeGreaterThanOrEqual(1);
    });
    it('does not breach the budget (a funding flip is a view change, not a tail loss)', () => {
      expect(r.budgetRespected).toBe(true);
    });
  });

  describe('feed blackout', () => {
    const r = runStressScenario('feed-blackout', { symbols: ['BTC', 'ETH', 'SOL'] });
    it('forces STAND_ASIDE on every book and flattens the desk', () => {
      expect(r.standAsideBooks).toBe(3);
      expect(r.allHeldStoodAside).toBe(true);
      expect(r.flatAtEnd).toBe(true);
    });
  });

  it('every scenario respects the budget invariant (regression guard over the whole set)', () => {
    for (const kind of STRESS_SCENARIOS) {
      const r = runStressScenario(kind as StressScenarioKind, { symbols: ['BTC', 'ETH', 'SOL'] });
      expect(r.budgetRespected).toBe(true);
    }
  });

  it('builds a deterministic path: warmup + shock steps per symbol', () => {
    const path = buildStressPath('flash-crash', {
      symbols: ['BTC', 'ETH'], baseNotionalUsd: 50_000, stopFrac: 0.02, maxDrawdownFrac: 0.02, warmupSteps: 14, shockSteps: 6,
    });
    expect(path.get('BTC')).toHaveLength(20);
    // the crash step is a ~−15% gap from the prior close.
    const btc = path.get('BTC')!;
    const gap = btc[14].midUsd / btc[13].midUsd;
    expect(gap).toBeCloseTo(0.85, 2);
  });
});
