import { Side } from '../stat-arb/trading-venue.interface';
import { estimateSlippage } from './slippage-model';

// Multi-venue split — given a parent notional and N venues, decide how much
// to send to each venue so that the marginal slippage cost across all
// participating venues is equalised. The linear-impact model
// (impactBps = lambda * size / ADV) makes the optimum closed-form:
//
//   For two venues with ADV a1, a2 and equal lambda, optimal share s_i is
//   proportional to ADV_i. (Same lambda assumption is reasonable per-venue
//   tier; if it doesn't hold we'd fall back to greedy fill which we do below
//   anyway as a defensive fallback when ADVs are zero or unknown.)
//
// We use a discretised greedy fill (split into K chunks; each chunk goes to
// the venue with the lowest marginal cost given current allocation). It works
// for any monotone-increasing cost curve and ties cleanly with the linear-
// impact closed form when the curve is linear.

export interface VenueLiquidity {
  venueId: string;
  /** Average daily volume in USDC units. */
  advUnits: bigint;
  /** Optional per-venue lambda override; falls back to slippage-model default. */
  lambdaBps?: number;
  /** Optional per-venue hard cap on notional. */
  maxNotionalUnits?: bigint;
}

export interface VenueAllocation {
  venueId: string;
  notionalUnits: bigint;
  estCostUnits: bigint;
  estImpactBps: number;
}

export interface SplitResult {
  allocations: VenueAllocation[];
  totalAllocatedUnits: bigint;
  totalEstCostUnits: bigint;
  /** True iff totalAllocated < requested (some venues hit maxNotional or had 0 ADV). */
  underfilled: boolean;
}

export interface SplitInputs {
  parentNotionalUnits: bigint;
  side: Side;
  venues: VenueLiquidity[];
  /** Number of greedy chunks; bigger = finer allocation, slower. Default 100. */
  chunks?: number;
}

export function splitAcrossVenues(i: SplitInputs): SplitResult {
  if (i.parentNotionalUnits <= 0n) {
    return { allocations: [], totalAllocatedUnits: 0n, totalEstCostUnits: 0n, underfilled: false };
  }
  if (i.venues.length === 0) {
    throw new Error('splitAcrossVenues: at least one venue required');
  }

  const chunks = i.chunks ?? 100;
  const perChunk = i.parentNotionalUnits / BigInt(chunks);
  const remainder = i.parentNotionalUnits - perChunk * BigInt(chunks);

  // Per-venue running allocation.
  const alloc = new Map<string, bigint>();
  for (const v of i.venues) alloc.set(v.venueId, 0n);

  // Greedy fill chunk-by-chunk. Marginal cost ranking uses float arithmetic
  // because estimateSlippage rounds impactBps to integer bp before computing
  // a bigint cost — that truncates to 0 for the chunk sizes used here and
  // breaks the comparison. The float marginal is used for ranking only;
  // running notional stays in bigint.
  const marginalFloat = (current: bigint, next: bigint, v: VenueLiquidity): number => {
    if (v.advUnits <= 0n) return Number.POSITIVE_INFINITY;
    const lambda = v.lambdaBps ?? 100;
    const adv = Number(v.advUnits);
    const cost = (x: bigint): number => {
      const xn = Number(x);
      return (lambda * xn * xn) / (10_000 * adv);
    };
    return cost(next) - cost(current);
  };

  for (let c = 0; c < chunks; c++) {
    const size = c === chunks - 1 ? perChunk + remainder : perChunk;
    if (size <= 0n) break;
    let best: { venue: VenueLiquidity; cost: number } | null = null;
    for (const v of i.venues) {
      const current = alloc.get(v.venueId)!;
      if (v.maxNotionalUnits !== undefined && current + size > v.maxNotionalUnits) continue;
      const marginal = marginalFloat(current, current + size, v);
      if (best === null || marginal < best.cost) best = { venue: v, cost: marginal };
    }
    if (best === null) break; // Every venue at its cap.
    alloc.set(best.venue.venueId, alloc.get(best.venue.venueId)! + size);
  }

  // Build the final allocation list. Drop zero-share venues so the consumer
  // doesn't fire empty orders.
  const allocations: VenueAllocation[] = [];
  let totalCost = 0n;
  let totalAllocated = 0n;
  for (const v of i.venues) {
    const units = alloc.get(v.venueId)!;
    if (units <= 0n) continue;
    const est = estimateSlippage({ notionalUnits: units, advUnits: v.advUnits, lambdaBps: v.lambdaBps, side: i.side });
    allocations.push({ venueId: v.venueId, notionalUnits: units, estCostUnits: est.costUnits, estImpactBps: est.impactBps });
    totalCost += est.costUnits;
    totalAllocated += units;
  }
  return {
    allocations,
    totalAllocatedUnits: totalAllocated,
    totalEstCostUnits: totalCost,
    underfilled: totalAllocated < i.parentNotionalUnits,
  };
}
