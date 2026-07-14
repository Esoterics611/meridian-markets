/**
 * carry-allocator — E7 v0 (PROFIT_PIVOT_II P1 item 4): fixed-weight allocation across
 * the gated carry universe + the aggregate beta-hedge input.
 *
 * v0 is deliberately dumb-and-honest: equal weights across the deployable, rate-gated
 * legs, hard-capped per leg, remainder stays in cash (doctrine #1: conserve equity —
 * un-allocated is a position, not a failure). An optional rate tilt exists but is OFF
 * by default: v0's pre-registered metric compares desk carry rate vs the P0 ETH-solo
 * rate at ≤2× realised vol, and equal-weight is the defensible baseline to measure
 * tilts against later.
 *
 * The hedge: two-leg carry pairs are delta-neutral by construction
 * (residualDeltaFracOfNotional = 0). HL-only variants (no-spot passers, short-perp
 * funding side) carry ±1 residual delta; the allocator rolls every leg's residual into
 * BookBeta[] that feeds straight into the existing RegimeBetaHedge (one BTC/ETH leg).
 * Pure function, no I/O.
 */
import { BookBeta } from '../directional/regime-beta-hedge';

export interface CarryCandidate {
  symbol: string;
  /** OOS gross funding rate, annualized fraction (0.08 = 8%/yr). */
  annualRateFrac: number;
  /** OOS persistence (fraction of windows funding stayed one-sided). */
  persistenceFrac: number;
  /** Passed the full gate (persistence + recency veto + spot + liquidity + #92 basis guard). */
  deployable: boolean;
  /**
   * Signed residual delta per $1 of allocated notional once the leg is open:
   * 0 for two-leg delta-neutral pairs; −1 for a naked short-perp HL-only variant.
   */
  residualDeltaFracOfNotional: number;
  /** Beta to the hedge instrument (BTC unless configured otherwise). */
  beta: number;
}

export interface CarryAllocatorConfig {
  totalNotionalUsd: number;
  /** Max legs funded. Default 12 (the gated list minus LIT). */
  maxLegs: number;
  /** Hard cap per leg — no single funding stream owns the desk. Default 0.15. */
  maxWeightPerLeg: number;
  /** Legs below this annualized rate are not worth the fee round-trip. Default 0.05. */
  minAnnualRateFrac: number;
  /** OFF in v0 (fixed weights). ON: weight ∝ rate, still capped + renormalized. */
  rateTilt: boolean;
}

export const DEFAULT_CARRY_ALLOCATOR_CONFIG: CarryAllocatorConfig = {
  totalNotionalUsd: 10_000,
  maxLegs: 12,
  maxWeightPerLeg: 0.15,
  minAnnualRateFrac: 0.05,
  rateTilt: false,
};

export interface CarryAllocation {
  symbol: string;
  weight: number;
  notionalUsd: number;
  annualRateFrac: number;
}

export interface CarryAllocationResult {
  allocations: CarryAllocation[];
  /** Fraction of the desk left un-allocated (caps/filters) — sits in cash, on purpose. */
  cashWeight: number;
  /** Σ weight × rate — the desk's expected gross carry rate, annualized fraction. */
  expectedGrossRateFrac: number;
  /** Residual-delta exposures, ready for RegimeBetaHedge.rebalance(). */
  bookBetas: BookBeta[];
}

export function allocateCarry(
  candidates: readonly CarryCandidate[],
  cfg: CarryAllocatorConfig = DEFAULT_CARRY_ALLOCATOR_CONFIG,
): CarryAllocationResult {
  const eligible = candidates
    .filter((c) => c.deployable && c.annualRateFrac >= cfg.minAnnualRateFrac)
    .sort((a, b) => b.annualRateFrac - a.annualRateFrac)
    .slice(0, cfg.maxLegs);

  let weights: number[];
  if (eligible.length === 0) {
    weights = [];
  } else if (cfg.rateTilt) {
    const rateSum = eligible.reduce((s, c) => s + c.annualRateFrac, 0);
    weights = eligible.map((c) => c.annualRateFrac / rateSum);
    // cap-and-redistribute once; anything still over after one pass stays cash (honest, simple)
    const over = weights.map((w) => Math.max(0, w - cfg.maxWeightPerLeg));
    const spare = over.reduce((s, x) => s + x, 0);
    const uncappedIdx = weights.map((w, i) => (w < cfg.maxWeightPerLeg ? i : -1)).filter((i) => i >= 0);
    weights = weights.map((w) => Math.min(w, cfg.maxWeightPerLeg));
    if (spare > 0 && uncappedIdx.length > 0) {
      const add = spare / uncappedIdx.length;
      for (const i of uncappedIdx) weights[i] = Math.min(weights[i] + add, cfg.maxWeightPerLeg);
    }
  } else {
    const w = Math.min(1 / eligible.length, cfg.maxWeightPerLeg);
    weights = eligible.map(() => w);
  }

  const allocations: CarryAllocation[] = eligible.map((c, i) => ({
    symbol: c.symbol,
    weight: weights[i],
    notionalUsd: weights[i] * cfg.totalNotionalUsd,
    annualRateFrac: c.annualRateFrac,
  }));
  const allocated = weights.reduce((s, w) => s + w, 0);
  const expectedGrossRateFrac = allocations.reduce((s, a) => s + a.weight * a.annualRateFrac, 0);
  const bookBetas: BookBeta[] = eligible
    .map((c, i) => ({
      symbol: c.symbol,
      signedNotionalUsd: c.residualDeltaFracOfNotional * allocations[i].notionalUsd,
      beta: c.beta,
    }))
    .filter((b) => b.signedNotionalUsd !== 0);

  return { allocations, cashWeight: 1 - allocated, expectedGrossRateFrac, bookBetas };
}
