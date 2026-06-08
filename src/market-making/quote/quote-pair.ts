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
  /**
   * Optional fair-value / quote center (the "theo") the quotes should straddle —
   * e.g. the book-imbalance micro-price (FAIR_VALUE_AND_THESIS_DESIGN.md F1). When
   * set, a quoter centers its reservation on THIS instead of the raw mid (the
   * adverse-selection fix: quote where price is going, not where it is). Undefined
   * ⇒ use midMicros (the legacy behaviour; nothing regresses). Spread width + rails
   * stay scaled off midMicros so the spread is unchanged — only the center moves.
   */
  readonly referenceMicros?: bigint;
  /**
   * Optional confidence-scaled spread multiplier (FAIR_VALUE_AND_THESIS_DESIGN.md
   * F3): the quoter multiplies its half-spread by this. < 1 ⇒ TIGHTEN (we're
   * confident — calm/benign flow, the rebate-farming regime); > 1 ⇒ WIDEN (uncertain
   * / toxic flow, where adverse selection lives). The driver (flow toxicity, fair-
   * value uncertainty Σ) is computed by the runtime. Undefined/1 ⇒ unchanged.
   */
  readonly spreadScale?: number;
  /** Per-bar realised volatility as a fraction of price (e.g. 0.0004 = 4 bps/bar). */
  readonly volatility: number;
  /** γ — risk aversion. Larger = more inventory-averse = wider, more-skewed quotes. */
  readonly riskAversion: number;
  /** κ — order-arrival decay (λ(δ)=A·e^{-κδ}). Larger = flow thins faster with distance. */
  readonly arrivalDecay: number;
  /** (T−t): horizon in bars. AS shrinks the spread as this → 0; GLFT ignores it. */
  readonly horizonBars: number;
  /**
   * Optional directional bias in [−1, +1] (DIRECTIONAL_MM_STRATEGY.md): the axed
   * maker rests at a TARGET inventory q* = bias·Q_max instead of 0. +1 = max long,
   * −1 = max short, 0 = neutral. Already OOS-gated by the runtime — an unvalidated
   * view arrives here as 0, so a quoter may use it directly. Only the directional
   * quoter reads it; every other quoter ignores it (b=0 ⇒ today's neutral book).
   */
  readonly bias?: number;
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
  /**
   * Optional ASYMMETRIC per-side half-spreads (the directional skew / single-siding):
   * tighten the side we want filled, widen/park the offload side. Default ⇒ symmetric
   * (= halfSpreadMicros both sides), so every non-directional quoter is unchanged.
   */
  bidHalfSpreadMicros?: bigint;
  askHalfSpreadMicros?: bigint;
  sizeUnits: bigint;
  ctx: QuoteContext;
  strategyId: string;
  tickSeq: number;
  clock: () => Date;
}

/**
 * Assemble a {bid,ask} QuotePair from a reservation price and a half-spread.
 * Bid is floored, ask is ceiled, guaranteeing bid < ask by at least 2 micros
 * even when the half-spread rounds to zero. Per-side half-spreads default to the
 * symmetric `halfSpreadMicros`; supplying them independently skews the quote.
 */
export function buildQuotePair(a: BuildQuotePairArgs): QuotePair {
  const base = a.halfSpreadMicros > 0n ? a.halfSpreadMicros : 1n;
  const sideHalf = (x: bigint | undefined): bigint => (x === undefined ? base : x > 0n ? x : 1n);
  const bidHalf = sideHalf(a.bidHalfSpreadMicros);
  const askHalf = sideHalf(a.askHalfSpreadMicros);
  const bidMicros = a.reservationMicros - bidHalf;
  const askMicros = a.reservationMicros + askHalf;
  const req = (s: QuoteSide, priceMicros: bigint): QuoteRequest => ({
    side: s,
    priceMicros,
    sizeUnits: a.sizeUnits,
    postOnly: true,
    timeInForce: 'POST_ONLY',
    idempotencyKey: `${a.strategyId}-${a.tickSeq}-${s}`,
  });
  return {
    ts: a.clock(),
    symbol: a.symbol,
    bid: req('bid', bidMicros),
    ask: req('ask', askMicros),
    reservationMicros: a.reservationMicros,
    halfSpreadMicros: base,
    context: a.ctx,
  };
}
