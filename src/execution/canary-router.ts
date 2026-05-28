import {
  Fill,
  ITradingVenue,
  PlaceOrderRequest,
} from '../stat-arb/trading-venue.interface';

// CanaryRouter — splits each placeOrder call across a paper venue and a real
// venue, weighted by `paperPct`. The default is 100% paper. The "real" leg is
// guarded by a hard boot assertion in the higher-level EXECUTION_MODE check;
// the router itself stays mode-agnostic so it's unit-testable.
//
// Why split per-call (not per-parent): the strategy doesn't know the canary
// exists. It calls `ITradingVenue.placeOrder` as normal; the canary multiplexes
// the call internally so the audit log has matched paper + real fills for
// every trader intent.
//
// Out of scope: drift attribution between paper and real (paper fills are
// theoretical; real fills carry venue micro-structure). That belongs to the
// reconciliation cron — see reconciliation.cron.ts.

export interface CanaryRouterConfig {
  /** Percentage of each parent notional sent to the paper leg. 0..100. */
  paperPct: number;
}

export interface CanaryFill extends Fill {
  /** Which leg this fill came from. */
  source: 'paper' | 'real';
  /** Original parent notional (so attribution sees the full intent). */
  parentNotionalUnits: bigint;
}

export interface CanaryRouterResult {
  paperFill?: CanaryFill;
  realFill?: CanaryFill;
  totalFilledUnits: bigint;
  parentNotionalUnits: bigint;
}

export class CanaryRouter implements ITradingVenue {
  readonly venueId: string;

  constructor(
    private readonly paper: ITradingVenue,
    private readonly real: ITradingVenue,
    private readonly cfg: CanaryRouterConfig,
  ) {
    if (cfg.paperPct < 0 || cfg.paperPct > 100) {
      throw new Error('CanaryRouter: paperPct must be in [0, 100]');
    }
    this.venueId = `canary(${paper.venueId}+${real.venueId})`;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    const out = await this.placeOrderSplit(req);
    // ITradingVenue contract returns a single Fill — synthesise an aggregate
    // from whichever leg(s) executed. Callers that need leg-level detail use
    // placeOrderSplit() directly.
    if (out.paperFill && out.realFill) {
      // Aggregate: side and symbol from the paper leg (identical); use a
      // notional-weighted average price.
      const totalNotional = out.paperFill.filledUnits + out.realFill.filledUnits;
      const weightedPrice = totalNotional === 0n
        ? out.paperFill.priceMicros
        : (out.paperFill.priceMicros * out.paperFill.filledUnits + out.realFill.priceMicros * out.realFill.filledUnits) / totalNotional;
      return {
        orderId: `canary-${out.paperFill.orderId}+${out.realFill.orderId}`,
        symbol: req.symbol,
        side: req.side,
        filledUnits: totalNotional,
        priceMicros: weightedPrice,
        feesUnits: out.paperFill.feesUnits + out.realFill.feesUnits,
        executedAt: out.realFill.executedAt,
      };
    }
    if (out.paperFill) return stripSource(out.paperFill);
    if (out.realFill) return stripSource(out.realFill);
    throw new Error('CanaryRouter.placeOrder: no fill produced');
  }

  /** Place across both legs and return per-leg fills. Use when the audit log needs both. */
  async placeOrderSplit(req: PlaceOrderRequest): Promise<CanaryRouterResult> {
    const paperUnits = (req.notionalUnits * BigInt(Math.floor(this.cfg.paperPct))) / 100n;
    const realUnits = req.notionalUnits - paperUnits;

    let paperFill: CanaryFill | undefined;
    let realFill: CanaryFill | undefined;

    if (paperUnits > 0n) {
      const fill = await this.paper.placeOrder({
        symbol: req.symbol,
        side: req.side,
        notionalUnits: paperUnits,
        idempotencyKey: `${req.idempotencyKey}-paper`,
      });
      paperFill = { ...fill, source: 'paper', parentNotionalUnits: req.notionalUnits };
    }
    if (realUnits > 0n) {
      const fill = await this.real.placeOrder({
        symbol: req.symbol,
        side: req.side,
        notionalUnits: realUnits,
        idempotencyKey: `${req.idempotencyKey}-real`,
      });
      realFill = { ...fill, source: 'real', parentNotionalUnits: req.notionalUnits };
    }

    return {
      paperFill,
      realFill,
      totalFilledUnits: (paperFill?.filledUnits ?? 0n) + (realFill?.filledUnits ?? 0n),
      parentNotionalUnits: req.notionalUnits,
    };
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    // Prefer the real venue's price feed — that's the source of truth once
    // we exit pure paper. In paper-only mode (paperPct=100) the real venue
    // is still allowed to be a dormant stub; fetchPrice still calls it but
    // the stub's behaviour is up to the caller.
    return this.real.fetchPrice(symbol);
  }
}

function stripSource(f: CanaryFill): Fill {
  const { source: _s, parentNotionalUnits: _p, ...rest } = f;
  return rest;
}
