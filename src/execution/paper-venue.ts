import {
  Fill,
  ITradingVenue,
  PlaceOrderRequest,
} from '../stat-arb/trading-venue.interface';
import { estimateSlippage } from './slippage-model';

// PaperVenue — implements ITradingVenue but writes orders to an in-memory
// paper book instead of hitting a real exchange. Consumes a live-style price
// stream (here: an injected `pricePoller`) so realised fills are pegged to
// actual market behaviour, not to a deterministic mock.
//
// This is the spine of Session 14. Once a real-bar ingest cron exists, you
// can flip EXECUTION_MODE=paper against the same live feed that the strategy
// reads from. Paper PnL becomes informative without exposing real capital.
//
// PaperVenue is mock-default-safe: it never reaches a real network. The KYB
// gate stays in front of `live` and `canary` modes.

export interface PaperOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  notionalUnits: bigint;
  priceMicros: bigint;
  feesUnits: bigint;
  filledAt: Date;
  idempotencyKey: string;
}

export interface PaperPosition {
  symbol: string;
  longUnits: bigint;
  shortUnits: bigint;
}

export interface PaperVenueDeps {
  /** Live price provider — called per placeOrder. */
  pricePoller: (symbol: string) => Promise<bigint>;
  /** Wall-clock injection for deterministic specs. */
  now?: () => Date;
  /** Taker fee in bps. Default 5 bps (Binance spot tier 1). */
  takerFeeBps?: bigint;
  /** Optional venueId override for canary attribution. Default 'paper'. */
  venueId?: string;
  /**
   * Optional slippage model. When set, the fill price is moved adversely by the
   * modelled linear price impact (BUY fills higher, SELL fills lower) so paper
   * results track live more closely. Omit for a frictionless fill.
   */
  slippage?: { advUnits: bigint; lambdaBps?: number };
}

export class PaperVenue implements ITradingVenue {
  readonly venueId: string;
  private readonly book = new Map<string, PaperOrder>();
  private readonly positions = new Map<string, PaperPosition>();
  private nonce = 0;
  private readonly now: () => Date;
  private readonly takerFeeBps: bigint;

  constructor(private readonly deps: PaperVenueDeps) {
    this.venueId = deps.venueId ?? 'paper';
    this.now = deps.now ?? (() => new Date());
    this.takerFeeBps = deps.takerFeeBps ?? 5n;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    const cached = this.book.get(req.idempotencyKey);
    if (cached) {
      return {
        orderId: cached.orderId,
        symbol: cached.symbol,
        side: cached.side,
        filledUnits: cached.notionalUnits,
        priceMicros: cached.priceMicros,
        feesUnits: cached.feesUnits,
        executedAt: cached.filledAt,
      };
    }

    if (req.notionalUnits <= 0n) {
      throw new Error(`PaperVenue.placeOrder: notionalUnits must be > 0; got ${req.notionalUnits}`);
    }

    const midMicros = await this.deps.pricePoller(req.symbol);
    const priceMicros = this.applySlippage(midMicros, req);
    const feesUnits = (req.notionalUnits * this.takerFeeBps) / 10_000n;
    const order: PaperOrder = {
      orderId: `${this.venueId}-paper-${++this.nonce}`,
      symbol: req.symbol,
      side: req.side,
      notionalUnits: req.notionalUnits,
      priceMicros,
      feesUnits,
      filledAt: this.now(),
      idempotencyKey: req.idempotencyKey,
    };
    this.book.set(req.idempotencyKey, order);

    const pos = this.positions.get(req.symbol) ?? { symbol: req.symbol, longUnits: 0n, shortUnits: 0n };
    if (req.side === 'BUY') pos.longUnits += req.notionalUnits;
    else pos.shortUnits += req.notionalUnits;
    this.positions.set(req.symbol, pos);

    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      filledUnits: order.notionalUnits,
      priceMicros: order.priceMicros,
      feesUnits: order.feesUnits,
      executedAt: order.filledAt,
    };
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    return this.deps.pricePoller(symbol);
  }

  /** Move the mid adversely by modelled impact. No-op when no slippage configured. */
  private applySlippage(midMicros: bigint, req: PlaceOrderRequest): bigint {
    const s = this.deps.slippage;
    if (!s) return midMicros;
    const { signedImpactBps } = estimateSlippage({
      notionalUnits: req.notionalUnits,
      advUnits: s.advUnits,
      lambdaBps: s.lambdaBps,
      side: req.side,
    });
    // adjusted = mid * (1 + signedImpactBps/10_000). signed is + for BUY, − for SELL.
    const bps = BigInt(Math.round(signedImpactBps));
    const adjusted = midMicros + (midMicros * bps) / 10_000n;
    return adjusted > 0n ? adjusted : midMicros;
  }

  /** Read-only snapshot of the paper book. Used by the reconciliation cron. */
  bookSnapshot(): PaperOrder[] {
    return Array.from(this.book.values());
  }

  positionSnapshot(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  /** Net notional (long - short) per symbol. */
  netNotional(symbol: string): bigint {
    const p = this.positions.get(symbol);
    if (!p) return 0n;
    return p.longUnits - p.shortUnits;
  }

  reset(): void {
    this.book.clear();
    this.positions.clear();
    this.nonce = 0;
  }
}
