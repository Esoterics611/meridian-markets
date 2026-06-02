import type { ManagedStrategy } from '../backtest/strategy.interface';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { BollingerPairsStrategy } from './bollinger-pairs-strategy';
import { OuSpreadStrategy } from './ou-spread-strategy';

// StrategyRegistry — the desk's catalogue of tradeable strategies.
//
// Course §8.5 ("a multi-strategy desk") frames a strategy as *a pure signal plus
// a registry entry*. This is that registry: each entry is a self-contained
// StrategyDefinition with an id, the course family it belongs to, a human label,
// a default risk profile, its frozen default tuning, and a `build()` that
// produces a fresh LiveStrategy for a chosen pair (per-pair β from discovery).
//
// Everything registered here satisfies the structural LiveStrategy contract, so
// any entry can be dropped into the live paper loop (LivePaperTrader) AND the
// backtest runner unchanged — the seam the whole engine is built around.
//
// Cross-sectional baskets (§8.2, N-leg) and funding carry (§8.4, perp+spot) are
// catalogued with `liveCapable: false` because today's live loop is strictly
// 2-leg; their signals + backtests ship separately (see strategies/cross-sectional.ts,
// strategies/funding-carry.ts) and the live wiring is a documented gap.

export type StrategyFamily =
  | 'cointegration' // course §2
  | 'ou' // course §3
  | 'cross-sectional' // course §8.2
  | 'funding-carry'; // course §8.4

export type RiskProfileId = 'conservative' | 'balanced' | 'aggressive';

export interface RiskProfile {
  id: RiskProfileId;
  /** Drawdown gate ceiling for the book running this strategy. */
  maxDrawdownPct: number;
  /**
   * Fraction of the book's capital to commit per leg. Two legs per pair, so the
   * gross book deployment is ≈ 2 × this. Conservative books leave dry powder.
   */
  notionalFraction: number;
}

export const RISK_PROFILES: Record<RiskProfileId, RiskProfile> = {
  conservative: { id: 'conservative', maxDrawdownPct: 5, notionalFraction: 0.1 },
  balanced: { id: 'balanced', maxDrawdownPct: 10, notionalFraction: 0.25 },
  aggressive: { id: 'aggressive', maxDrawdownPct: 20, notionalFraction: 0.4 },
};

/** Runtime inputs the desk supplies per deployment (the rest is frozen tuning). */
export interface StrategyBuildOpts {
  /** Hedge ratio from pair discovery (cointegration β). */
  beta: number;
  /** Per-leg notional in 6-decimal USDC units. */
  notionalUnits: bigint;
  /**
   * Optional per-launch overrides of the strategy's frozen `defaultParams`,
   * keyed by the same names (e.g. { entryZ, exitZ, zLookback }). Supplied by the
   * human launch form; anything omitted falls back to the catalogue default.
   */
  params?: Record<string, number>;
}

export interface StrategyDefinition {
  id: string;
  family: StrategyFamily;
  label: string;
  description: string;
  /** Course chapter this strategy is drawn from, for the desk UI. */
  courseRef: string;
  /** Whether this strategy runs in today's 2-leg live paper loop. */
  liveCapable: boolean;
  defaultRiskProfile: RiskProfileId;
  /** Frozen default tuning, surfaced to the UI for transparency. */
  defaultParams: Record<string, number>;
  /** Construct a fresh strategy instance for a chosen pair. */
  build(opts: StrategyBuildOpts): ManagedStrategy;
}

// --- The catalogue ----------------------------------------------------------

const PAIRS_ZSCORE: StrategyDefinition = {
  id: 'pairs-zscore',
  family: 'cointegration',
  label: 'Pairs — rolling z-score',
  description:
    'Cointegration pairs (§2): rolling z of the log-spread, ±entry/exit bands, sliding-β refit with a p-value gate.',
  courseRef: '§2 Cointegration',
  liveCapable: true,
  defaultRiskProfile: 'balanced',
  defaultParams: { zLookback: 60, entryZ: 2.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 1.5, betaWeighted: 0 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { zLookback: 60, entryZ: 2.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 1.5, betaWeighted: 0, ...params };
    return new PairsStrategy({
      beta,
      zLookback: p.zLookback,
      entryZ: p.entryZ,
      exitZ: p.exitZ,
      notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
      feeBps: p.feeBps,
      minEdgeMultiple: p.minEdgeMultiple,
      betaWeightedSizing: p.betaWeighted > 0,
    });
  },
};

const PAIRS_EWMA: StrategyDefinition = {
  id: 'pairs-ewma',
  family: 'cointegration',
  label: 'Pairs — EWMA z-score',
  description:
    'Cointegration pairs (§2), EWMA variant: exponentially weighted mean/var z reacts faster to a spread regime change; no hard window edge.',
  courseRef: '§2 Cointegration (EWMA)',
  liveCapable: true,
  defaultRiskProfile: 'balanced',
  defaultParams: { lambda: 0.94, warmupBars: 60, entryZ: 2.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 1.5 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { lambda: 0.94, warmupBars: 60, entryZ: 2.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 1.5, ...params };
    return new BollingerPairsStrategy({
      beta,
      lambda: p.lambda,
      warmupBars: p.warmupBars,
      entryZ: p.entryZ,
      exitZ: p.exitZ,
      notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
      feeBps: p.feeBps,
      minEdgeMultiple: p.minEdgeMultiple,
    });
  },
};

// Added by the quant desk (see docs/QUANT_JOURNAL.md, 2026-06-01): the 15m /
// ~10-day study found that net-of-fee profit + a high Sharpe come from FEW,
// HIGH-EDGE entries — a wider entry band and a stiffer fee-floor gate — not from
// trading often. This codifies that regime: ±2.5 entry and a 2× fee-floor edge
// requirement. Best deployed on slower bars (5–15m) where σ-per-trade clears the
// ~20 bps round-trip cost with margin.
const PAIRS_ZSCORE_SELECTIVE: StrategyDefinition = {
  id: 'pairs-zscore-selective',
  family: 'cointegration',
  label: 'Pairs — z-score (selective)',
  description:
    'Cointegration pairs (§2), high-conviction tuning: ±2.5 entry band + a 2× fee-floor edge gate so only entries with edge well clear of the ~20 bps round-trip fire. Fewer trades, higher edge each — the desk-research regime that turns a profit after fees.',
  courseRef: '§2 Cointegration (selective)',
  liveCapable: true,
  defaultRiskProfile: 'conservative',
  defaultParams: { zLookback: 60, entryZ: 2.5, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.0, betaWeighted: 0 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { zLookback: 60, entryZ: 2.5, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.0, betaWeighted: 0, ...params };
    return new PairsStrategy({
      beta,
      zLookback: p.zLookback,
      entryZ: p.entryZ,
      exitZ: p.exitZ,
      notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
      feeBps: p.feeBps,
      minEdgeMultiple: p.minEdgeMultiple,
      betaWeightedSizing: p.betaWeighted > 0,
    });
  },
};

// Most selective cointegration entry: only extreme ±3σ dislocations, exit at
// ±0.5, 2.5× fee gate. Rarest trades, fattest edge each — for noisy alt classes
// where the spread occasionally blows out far past the band.
const PAIRS_ZSCORE_WIDE: StrategyDefinition = {
  id: 'pairs-zscore-wide',
  family: 'cointegration',
  label: 'Pairs — z-score (wide ±3σ)',
  description:
    'Cointegration pairs (§2): only ±3σ dislocations fire, with a 2.5× fee-floor gate. Trades rarely; each entry has a large expected reversion well clear of fees. Built for high-vol alt classes (AI, gaming, L1) that overshoot.',
  courseRef: '§2 Cointegration (wide)',
  liveCapable: true,
  defaultRiskProfile: 'conservative',
  defaultParams: { zLookback: 60, entryZ: 3.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.5, betaWeighted: 0 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { zLookback: 60, entryZ: 3.0, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.5, betaWeighted: 0, ...params };
    return new PairsStrategy({
      beta, zLookback: p.zLookback, entryZ: p.entryZ, exitZ: p.exitZ, notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
      feeBps: p.feeBps, minEdgeMultiple: p.minEdgeMultiple,
      betaWeightedSizing: p.betaWeighted > 0,
    });
  },
};

// EWMA analog of the selective regime: faster-reacting z (no hard window) but
// the same high-conviction ±2.5 entry + 2× fee gate. The research's highest
// edge-per-trade configs were EWMA at a wide band (small n, fat edge).
const PAIRS_EWMA_CONVICTION: StrategyDefinition = {
  id: 'pairs-ewma-conviction',
  family: 'cointegration',
  label: 'Pairs — EWMA (conviction)',
  description:
    'Cointegration pairs (§2), EWMA z with a high-conviction ±2.5 entry and a 2× fee-floor gate. The fast EWMA catches a regime turn; the stiff gate keeps only entries whose edge clears the round-trip fee.',
  courseRef: '§2 Cointegration (EWMA conviction)',
  liveCapable: true,
  defaultRiskProfile: 'conservative',
  defaultParams: { lambda: 0.94, warmupBars: 60, entryZ: 2.5, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.0 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { lambda: 0.94, warmupBars: 60, entryZ: 2.5, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 2.0, ...params };
    return new BollingerPairsStrategy({
      beta, lambda: p.lambda, warmupBars: p.warmupBars, entryZ: p.entryZ, exitZ: p.exitZ, notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
      feeBps: p.feeBps, minEdgeMultiple: p.minEdgeMultiple,
    });
  },
};

const OU_BERTRAM: StrategyDefinition = {
  id: 'ou-bertram',
  family: 'ou',
  label: 'OU — Bertram bands',
  description:
    'Ornstein-Uhlenbeck mean-reversion (§3): fit θ/μ/σ on a rolling window, trade the simplified Bertram optimal entry/exit bands, stand aside when θ≤0 (not mean-reverting).',
  courseRef: '§3 OU process',
  liveCapable: true,
  defaultRiskProfile: 'conservative',
  defaultParams: { ouWindow: 120, txCostFraction: 0.0008 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { ouWindow: 120, txCostFraction: 0.0008, ...params };
    return new OuSpreadStrategy({
      beta,
      ouWindow: p.ouWindow,
      txCostFraction: p.txCostFraction,
      notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
    });
  },
};

const OU_BERTRAM_FAST: StrategyDefinition = {
  id: 'ou-bertram-fast',
  family: 'ou',
  label: 'OU — Bertram bands (fast)',
  description:
    'OU mean-reversion (§3), short-window variant: a 60-bar fit reacts to faster half-lives and tighter cost assumptions — more trades, more whipsaw, the §3 speed/edge trade-off.',
  courseRef: '§3 OU process (fast)',
  liveCapable: true,
  defaultRiskProfile: 'aggressive',
  defaultParams: { ouWindow: 60, txCostFraction: 0.0004 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { ouWindow: 60, txCostFraction: 0.0004, ...params };
    return new OuSpreadStrategy({
      beta,
      ouWindow: p.ouWindow,
      txCostFraction: p.txCostFraction,
      notionalUnits,
    });
  },
};

// OU's default txCostFraction (8 bps) UNDER-prices the real ~20 bps round-trip
// (4 taker fills), so its Bertram bands are too tight → it overtrades and bleeds
// on fees (the research's worst performers were OU-fast: 100+ trades, deep
// losses). Pricing the true cost widens the bands → far fewer, profitable
// trades. Same OU signal, honest cost.
const OU_BERTRAM_THROTTLED: StrategyDefinition = {
  id: 'ou-bertram-throttled',
  family: 'ou',
  label: 'OU — Bertram bands (fee-throttled)',
  description:
    'OU mean-reversion (§3) with the cost set to the TRUE ~20 bps round-trip, not the optimistic 8 bps default. Wider optimal bands ⇒ many fewer trades, each clearing fees — the fix for OU overtrading itself to death on a fee-heavy book.',
  courseRef: '§3 OU process (fee-throttled)',
  liveCapable: true,
  defaultRiskProfile: 'conservative',
  defaultParams: { ouWindow: 120, txCostFraction: 0.0020 },
  build: ({ beta, notionalUnits, params }) => {
    const p = { ouWindow: 120, txCostFraction: 0.0020, ...params };
    return new OuSpreadStrategy({
      beta, ouWindow: p.ouWindow, txCostFraction: p.txCostFraction, notionalUnits,
      betaRefit: { enabled: true, windowBars: 120, everyBars: 30, pValueGate: 0.1 },
    });
  },
};

const DEFINITIONS: StrategyDefinition[] = [
  PAIRS_ZSCORE,
  PAIRS_ZSCORE_SELECTIVE,
  PAIRS_ZSCORE_WIDE,
  PAIRS_EWMA,
  PAIRS_EWMA_CONVICTION,
  OU_BERTRAM,
  OU_BERTRAM_THROTTLED,
  OU_BERTRAM_FAST,
];

export class StrategyRegistry {
  private readonly byId = new Map<string, StrategyDefinition>();

  constructor(defs: StrategyDefinition[] = DEFINITIONS) {
    for (const d of defs) this.register(d);
  }

  register(def: StrategyDefinition): void {
    if (this.byId.has(def.id)) throw new Error(`duplicate strategy id: ${def.id}`);
    this.byId.set(def.id, def);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): StrategyDefinition {
    const d = this.byId.get(id);
    if (!d) throw new Error(`unknown strategy id: ${id}`);
    return d;
  }

  /** All live-capable definitions (the desk's deployable menu). */
  liveCapable(): StrategyDefinition[] {
    return [...this.byId.values()].filter((d) => d.liveCapable);
  }

  all(): StrategyDefinition[] {
    return [...this.byId.values()];
  }

  /** Build a strategy instance for a chosen pair from its catalogue id. */
  build(id: string, opts: StrategyBuildOpts): ManagedStrategy {
    return this.get(id).build(opts);
  }

  riskProfile(id: RiskProfileId): RiskProfile {
    return RISK_PROFILES[id];
  }
}

/** Process-wide default registry. */
export const strategyRegistry = new StrategyRegistry();
