/**
 * The promotion gate (docs/AGENTIC_HEDGE_FUND_DESIGN.md §3): the checklist a
 * trading station must pass before a quant flips it to `paper` and arms it. This
 * is where *risk* enters the quant agent's lifecycle. Pure + side-effect-free so
 * jest exercises the pass/fail logic; `mq validate` (bin/mq.ts) feeds it real
 * backtest + discovery numbers fetched over HTTP.
 */

/** Risk-profile drawdown ceilings — mirrors RISK_PROFILES in
 *  src/stat-arb/strategies/strategy-registry.ts. Keep the two in step. */
export const RISK_GATES = {
  conservative: { maxDrawdownPct: 5 },
  balanced: { maxDrawdownPct: 10 },
  aggressive: { maxDrawdownPct: 20 },
} as const;

export type RiskProfileId = keyof typeof RISK_GATES;

export interface GateThresholds {
  minTrades: number;
  minSharpe: number;
  maxDrawdownPct: number;
  requirePositivePnl: boolean;
  /** Cointegration p-value ceiling; only checked when a pValue is supplied. */
  maxPValue: number;
}

export interface GateInput {
  tradeCount: number;
  sharpe: number;
  maxDrawdownPct: number;
  netPnlUnits: bigint;
  /** From recent discovery; null/undefined ⇒ the cointegration check is skipped. */
  pValue?: number | null;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  actual: string;
  threshold: string;
  skipped?: boolean;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
}

/** Build the default thresholds for a risk profile, with optional overrides. */
export function thresholdsFor(
  profile: RiskProfileId,
  overrides: Partial<GateThresholds> = {},
): GateThresholds {
  return {
    minTrades: 5,
    minSharpe: 0.5,
    maxDrawdownPct: RISK_GATES[profile].maxDrawdownPct,
    requirePositivePnl: true,
    maxPValue: 0.2,
    ...overrides,
  };
}

/**
 * Run the gate. Returns one check per criterion plus an overall pass = every
 * non-skipped check passing. A skipped check (e.g. no p-value supplied) neither
 * passes nor fails — it's reported so the operator knows it wasn't enforced.
 */
export function evaluateGate(input: GateInput, t: GateThresholds): GateResult {
  const checks: GateCheck[] = [
    {
      name: 'min trades',
      pass: input.tradeCount >= t.minTrades,
      actual: String(input.tradeCount),
      threshold: `>= ${t.minTrades}`,
    },
    {
      name: 'sharpe',
      pass: input.sharpe >= t.minSharpe,
      actual: input.sharpe.toFixed(2),
      threshold: `>= ${t.minSharpe}`,
    },
    {
      name: 'max drawdown',
      pass: input.maxDrawdownPct <= t.maxDrawdownPct,
      actual: `${input.maxDrawdownPct.toFixed(2)}%`,
      threshold: `<= ${t.maxDrawdownPct}%`,
    },
  ];
  if (t.requirePositivePnl) {
    checks.push({
      name: 'net pnl positive',
      pass: input.netPnlUnits > 0n,
      actual: input.netPnlUnits.toString(),
      threshold: '> 0',
    });
  }
  if (input.pValue === null || input.pValue === undefined) {
    checks.push({
      name: 'cointegration p-value',
      pass: true,
      skipped: true,
      actual: 'n/a',
      threshold: `<= ${t.maxPValue} (pass --preset to enforce)`,
    });
  } else {
    checks.push({
      name: 'cointegration p-value',
      pass: input.pValue <= t.maxPValue,
      actual: input.pValue.toFixed(3),
      threshold: `<= ${t.maxPValue}`,
    });
  }
  const pass = checks.every((c) => c.skipped || c.pass);
  return { pass, checks };
}
