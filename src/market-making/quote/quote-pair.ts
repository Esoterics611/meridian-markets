// QuotePair — the structured output of every market-making quoter in the engine.
//
// Mirrors the market-making course's Appendix A.3 shape: one bid, one ask, both
// with size, both stamped with the inventory/market context that produced them.
// The stamping matters — the risk gate (risk/risk-gate.ts) and any post-mortem
// of a bad fill need to reconstruct *why* a quote was placed (which q, which σ,
// which γ). A bare bid/ask without that context is a debugging dead-end.
//
// Numeric convention (same as the rest of Meridian, CLAUDE.md §3):
//   - priceMicros : 1.0 quote-unit per asset = 1_000_000n (micros).
//   - sizeUnits   : asset quantity in 6-decimals, 1.0 asset = 1_000_000n.
//   - notional in USDC-units(6-dec) = sizeUnits * priceMicros / 1_000_000n.
// Quote-time math (σ, γ, the HJB half-spread) is float and lives inside the
// quoters' pure functions; everything is rounded back to bigint micros here,
// before a price crosses the venue boundary.

export type QuoteSide = 'bid' | 'ask';

export interface QuoteRequest {
  readonly side: QuoteSide;
  readonly priceMicros: bigint; // venue-tick-rounded
  readonly sizeUnits: bigint; // venue-lot-rounded asset quantity
  readonly postOnly: boolean; // true for a passive maker quote
  readonly timeInForce: 'GTC' | 'IOC' | 'POST_ONLY';
  readonly idempotencyKey: string; // {strategyId}-{tickSeq}-{side}
}

export interface QuoteContext {
  /** Signed inventory in asset units (6-dec). Positive = long the base asset. */
  readonly inventoryUnits: bigint;
  /** Reference mid in micros. */
  readonly midMicros: bigint;
  /** Per-bar realised volatility as a fraction of price (e.g. 0.0004 = 4 bps/bar). */
  readonly volatility: number;
  /** γ — risk aversion. Larger = more inventory-averse = wider, more-skewed quotes. */
  readonly riskAversion: number;
  /** κ — order-arrival decay (λ(δ)=A·e^{-κδ}). Larger = flow thins faster with distance. */
  readonly arrivalDecay: number;
  /** (T−t): horizon in bars. AS shrinks the spread as this → 0; GLFT ignores it. */
  readonly horizonBars: number;
  readonly schemaVersion: 1;
}

export interface QuotePair {
  readonly ts: Date;
  readonly symbol: string;
  readonly bid: QuoteRequest;
  readonly ask: QuoteRequest;
  /** r(s,q,t) — the inventory-skewed reservation price the quotes straddle. Pinned for debugging. */
  readonly reservationMicros: bigint;
  /** The (symmetric) half-spread actually applied, in micros. */
  readonly halfSpreadMicros: bigint;
  readonly context: QuoteContext;
}

export interface BuildQuotePairArgs {
  symbol: string;
  reservationMicros: bigint;
  halfSpreadMicros: bigint;
  sizeUnits: bigint;
  ctx: QuoteContext;
  strategyId: string;
  tickSeq: number;
  clock: () => Date;
}

/**
 * Assemble a {bid,ask} QuotePair from a reservation price and a half-spread.
 * Bid is floored, ask is ceiled, guaranteeing bid < ask by at least 2 micros
 * even when the half-spread rounds to zero.
 */
export function buildQuotePair(a: BuildQuotePairArgs): QuotePair {
  const half = a.halfSpreadMicros > 0n ? a.halfSpreadMicros : 1n;
  const bidMicros = a.reservationMicros - half;
  const askMicros = a.reservationMicros + half;
  const req = (side: QuoteSide, priceMicros: bigint): QuoteRequest => ({
    side,
    priceMicros,
    sizeUnits: a.sizeUnits,
    postOnly: true,
    timeInForce: 'POST_ONLY',
    idempotencyKey: `${a.strategyId}-${a.tickSeq}-${side}`,
  });
  return {
    ts: a.clock(),
    symbol: a.symbol,
    bid: req('bid', bidMicros),
    ask: req('ask', askMicros),
    reservationMicros: a.reservationMicros,
    halfSpreadMicros: half,
    context: a.ctx,
  };
}
