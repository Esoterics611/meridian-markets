import { evaluateGate, thresholdsFor, RISK_GATES, GateInput } from './validate-gate';

/** A backtest result that clears every check, used as the base for tweaks. */
const passing: GateInput = {
  tradeCount: 20,
  sharpe: 1.4,
  maxDrawdownPct: 6,
  netPnlUnits: 1_500_000n,
  pValue: 0.05,
};

describe('thresholdsFor', () => {
  it('pins maxDrawdownPct to the profile gate', () => {
    expect(thresholdsFor('conservative').maxDrawdownPct).toBe(5);
    expect(thresholdsFor('balanced').maxDrawdownPct).toBe(10);
    expect(thresholdsFor('aggressive').maxDrawdownPct).toBe(20);
  });

  it('mirrors RISK_GATES exactly for every profile', () => {
    (Object.keys(RISK_GATES) as Array<keyof typeof RISK_GATES>).forEach((p) => {
      expect(thresholdsFor(p).maxDrawdownPct).toBe(RISK_GATES[p].maxDrawdownPct);
    });
  });

  it('applies the documented defaults', () => {
    const t = thresholdsFor('balanced');
    expect(t.minTrades).toBe(5);
    expect(t.minSharpe).toBe(0.5);
    expect(t.requirePositivePnl).toBe(true);
    expect(t.maxPValue).toBe(0.2);
  });

  it('lets overrides win over the defaults', () => {
    const t = thresholdsFor('balanced', { minSharpe: 1.0, minTrades: 30, maxPValue: 0.1 });
    expect(t.minSharpe).toBe(1.0);
    expect(t.minTrades).toBe(30);
    expect(t.maxPValue).toBe(0.1);
    expect(t.maxDrawdownPct).toBe(10); // profile gate untouched by unrelated overrides
  });

  it('keeps the profile drawdown unless the override explicitly sets it', () => {
    expect(thresholdsFor('conservative', { minSharpe: 2 }).maxDrawdownPct).toBe(5);
    expect(thresholdsFor('conservative', { maxDrawdownPct: 3 }).maxDrawdownPct).toBe(3);
  });
});

describe('evaluateGate', () => {
  const t = thresholdsFor('balanced');

  it('passes a clean backtest on every check', () => {
    const r = evaluateGate(passing, t);
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.checks.some((c) => c.skipped)).toBe(false);
  });

  it('fails when sharpe is below the floor', () => {
    const r = evaluateGate({ ...passing, sharpe: 0.2 }, t);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'sharpe')!.pass).toBe(false);
  });

  it('fails when drawdown breaches the profile gate', () => {
    const r = evaluateGate({ ...passing, maxDrawdownPct: 14 }, t);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'max drawdown')!.pass).toBe(false);
  });

  it('fails when there are too few trades', () => {
    const r = evaluateGate({ ...passing, tradeCount: 2 }, t);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'min trades')!.pass).toBe(false);
  });

  it('fails on non-positive net pnl when required', () => {
    expect(evaluateGate({ ...passing, netPnlUnits: 0n }, t).pass).toBe(false);
    expect(evaluateGate({ ...passing, netPnlUnits: -1n }, t).pass).toBe(false);
  });

  it('omits the pnl check entirely when requirePositivePnl is false', () => {
    const t2 = thresholdsFor('balanced', { requirePositivePnl: false });
    const r = evaluateGate({ ...passing, netPnlUnits: -5n }, t2);
    expect(r.checks.find((c) => c.name === 'net pnl positive')).toBeUndefined();
    expect(r.pass).toBe(true);
  });

  it('skips the cointegration check when no p-value is supplied', () => {
    for (const pValue of [undefined, null] as const) {
      const r = evaluateGate({ ...passing, pValue }, t);
      const check = r.checks.find((c) => c.name === 'cointegration p-value')!;
      expect(check.skipped).toBe(true);
      expect(r.pass).toBe(true); // a skipped check never fails the gate
    }
  });

  it('enforces the cointegration check when a p-value is supplied', () => {
    expect(evaluateGate({ ...passing, pValue: 0.18 }, t).pass).toBe(true);
    const bad = evaluateGate({ ...passing, pValue: 0.5 }, t);
    expect(bad.pass).toBe(false);
    expect(bad.checks.find((c) => c.name === 'cointegration p-value')!.skipped).toBeFalsy();
  });

  it('requires every non-skipped check to pass for an overall pass', () => {
    expect(evaluateGate({ ...passing, maxDrawdownPct: 99 }, t).pass).toBe(false);
  });
});
