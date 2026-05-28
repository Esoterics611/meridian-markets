import { ITradingVenue, Side } from '../stat-arb/trading-venue.interface';
import { estimateSlippage } from './slippage-model';
import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';

// OrderRouter — given a parent order and N venues, the router:
//   1. asks each venue for its ADV / cost estimate (here: a simple model
//      consult against the slippage model)
//   2. picks the cheapest venue
//   3. slices the parent via the configured IExecAlgo
//   4. hands children to the venue in scheduleOffset order
//
// Session 13 lite: single-venue happy path. Multi-venue split + cost-aware
// routing land in the full Session 13.

export interface VenueQuote {
  venueId: string;
  advUnits: bigint;
  estCostUnits: bigint;
  estImpactBps: number;
}

export interface RouterPlan {
  chosenVenue: VenueQuote;
  children: ChildOrder[];
  totalEstCostUnits: bigint;
}

export class OrderRouter {
  constructor(
    private readonly algo: IExecAlgo,
    /** Map of venueId → ADV in USDC units. Replace with a live ADV provider later. */
    private readonly adv: Map<string, bigint>,
  ) {}

  plan(parent: ParentOrder, venues: ITradingVenue[]): RouterPlan {
    if (venues.length === 0) throw new Error('OrderRouter.plan: at least one venue required');
    const quotes: VenueQuote[] = venues.map((v) => {
      const advUnits = this.adv.get(v.venueId) ?? 0n;
      const e = estimateSlippage({ notionalUnits: parent.totalNotionalUnits, advUnits, side: parent.side });
      return { venueId: v.venueId, advUnits, estCostUnits: e.costUnits, estImpactBps: e.impactBps };
    });
    // Pick the lowest cost; ties broken by largest ADV (most liquid wins).
    quotes.sort((a, b) => {
      if (a.estCostUnits !== b.estCostUnits) return Number(a.estCostUnits - b.estCostUnits);
      return Number(b.advUnits - a.advUnits);
    });
    const chosen = quotes[0];
    const children = this.algo.sliceOrder(parent);
    return { chosenVenue: chosen, children, totalEstCostUnits: chosen.estCostUnits };
  }

  async execute(parent: ParentOrder, venues: ITradingVenue[]): Promise<RouterPlan & { filledNotionalUnits: bigint }> {
    const plan = this.plan(parent, venues);
    const venue = venues.find((v) => v.venueId === plan.chosenVenue.venueId)!;
    // Synchronous mock-friendly execution: ignore scheduleOffsetMs and submit in order.
    // A real scheduler would await a clock. Backtest-time replays still drive bars; this
    // method's role is to map the plan onto the venue, not to keep wall-clock time.
    let filled = 0n;
    for (const c of plan.children) {
      const fill = await venue.placeOrder({
        symbol: c.symbol,
        side: c.side as Side,
        notionalUnits: c.notionalUnits,
        idempotencyKey: `router-${plan.chosenVenue.venueId}-${parent.symbol}-${c.parentSliceIndex}-${Date.now()}`,
      });
      filled += fill.filledUnits;
    }
    return { ...plan, filledNotionalUnits: filled };
  }
}
