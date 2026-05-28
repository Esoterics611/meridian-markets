import { ITradingVenue, Side } from '../stat-arb/trading-venue.interface';
import { VenueCapGate } from '../stat-arb/risk/venue-cap';
import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';
import {
  SplitResult,
  VenueAllocation,
  VenueLiquidity,
  splitAcrossVenues,
} from './multi-venue-split';

// MultiVenueOrderRouter — splits a parent across N venues by the linear-
// impact closed form (via splitAcrossVenues), slices each venue's allocation
// via the configured IExecAlgo, then dispatches children in scheduleOffset
// order. Optionally consults a per-child VenueCapGate so fast-firing algos
// (TWAP/POV/iceberg) cannot bypass the per-venue cap by burying violations
// inside child orders.
//
// Difference from OrderRouter (single-venue, legacy):
//   - Plan returns an allocation per participating venue, not one winner.
//   - Each venue's child orders are independent; sum equals parent notional
//     when no caps bind, and the plan is marked `underfilled` when they do.

export interface VenueRoute {
  venueId: string;
  allocationUnits: bigint;
  estImpactBps: number;
  estCostUnits: bigint;
  children: ChildOrder[];
}

export interface MultiVenueRouterPlan {
  routes: VenueRoute[];
  totalAllocatedUnits: bigint;
  totalEstCostUnits: bigint;
  underfilled: boolean;
}

export interface MultiVenueRouterExecuteResult extends MultiVenueRouterPlan {
  filledNotionalUnits: bigint;
  blockedByCapCount: number;
}

export interface MultiVenueRouterOpts {
  /** Per-child gate consulted before each child order is placed. */
  venueCapGate?: VenueCapGate;
  /** Initial live notional per venue, in USDC units. Defaults to 0. */
  initialLiveNotional?: Map<string, bigint>;
}

export class MultiVenueOrderRouter {
  constructor(
    private readonly algo: IExecAlgo,
    private readonly liquidity: VenueLiquidity[],
    private readonly opts: MultiVenueRouterOpts = {},
  ) {
    if (liquidity.length === 0) throw new Error('MultiVenueOrderRouter: at least one venue liquidity entry required');
  }

  plan(parent: ParentOrder): MultiVenueRouterPlan {
    const split: SplitResult = splitAcrossVenues({
      parentNotionalUnits: parent.totalNotionalUnits,
      side: parent.side,
      venues: this.liquidity,
    });
    const routes: VenueRoute[] = split.allocations.map((a: VenueAllocation) => {
      const subParent: ParentOrder = {
        symbol: parent.symbol,
        side: parent.side,
        totalNotionalUnits: a.notionalUnits,
        maxSlices: parent.maxSlices,
      };
      const children = this.algo.sliceOrder(subParent);
      return {
        venueId: a.venueId,
        allocationUnits: a.notionalUnits,
        estImpactBps: a.estImpactBps,
        estCostUnits: a.estCostUnits,
        children,
      };
    });
    return {
      routes,
      totalAllocatedUnits: split.totalAllocatedUnits,
      totalEstCostUnits: split.totalEstCostUnits,
      underfilled: split.underfilled,
    };
  }

  async execute(parent: ParentOrder, venues: ITradingVenue[]): Promise<MultiVenueRouterExecuteResult> {
    const plan = this.plan(parent);
    const venueById = new Map(venues.map((v) => [v.venueId, v]));
    for (const r of plan.routes) {
      if (!venueById.has(r.venueId)) {
        throw new Error(`MultiVenueOrderRouter.execute: no ITradingVenue provided for ${r.venueId}`);
      }
    }
    const live = new Map<string, bigint>(this.opts.initialLiveNotional ?? new Map());
    let filled = 0n;
    let blockedByCap = 0;
    for (const r of plan.routes) {
      const venue = venueById.get(r.venueId)!;
      for (const c of r.children) {
        if (this.opts.venueCapGate) {
          const current = live.get(r.venueId) ?? 0n;
          const decision = this.opts.venueCapGate.check({
            venueId: r.venueId,
            liveNotionalUnits: current,
            addNotionalUnits: c.notionalUnits,
          });
          if (!decision.allow) {
            blockedByCap++;
            continue;
          }
        }
        const fill = await venue.placeOrder({
          symbol: c.symbol,
          side: c.side as Side,
          notionalUnits: c.notionalUnits,
          idempotencyKey: `mvr-${r.venueId}-${parent.symbol}-${c.parentSliceIndex}-${Date.now()}`,
        });
        filled += fill.filledUnits;
        live.set(r.venueId, (live.get(r.venueId) ?? 0n) + fill.filledUnits);
      }
    }
    return { ...plan, filledNotionalUnits: filled, blockedByCapCount: blockedByCap };
  }
}
