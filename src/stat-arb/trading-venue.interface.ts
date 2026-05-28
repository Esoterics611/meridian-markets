// ITradingVenue is the execution swap seam for the stat-arb engine.
// Same pattern as IHedgeVenue and IYieldProvider: consumers depend on this
// interface only; the concrete implementation (Mock vs Binance vs Coinbase
// vs Kraken) is selected once in StatArbModule's factory based on
// MOCK_TRADING_ENABLED.
//
// Scope: Phase 3 stat-arb demo. Spot pairs trading. First-party only, no
// customer money in Phase 3 (per PHASED_PLAN.md and cross-phase dep #1).

export const TRADING_VENUE = Symbol('TRADING_VENUE');

export type Side = 'BUY' | 'SELL';

// Notional in 6-decimal USDC units (1 USDC = 1_000_000). Prices in micros
// (1e6) to match the same BigInt-exact convention used for ILS quotes in
// the hedge module — no floats on the venue boundary.

export interface PlaceOrderRequest {
  symbol: string;
  side: Side;
  notionalUnits: bigint;
  idempotencyKey: string;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: Side;
  filledUnits: bigint;
  priceMicros: bigint;
  feesUnits: bigint;
  executedAt: Date;
}

export interface ITradingVenue {
  /** Stable identifier — would be written into stat_arb_trades.venue once persisted. */
  readonly venueId: string;

  placeOrder(req: PlaceOrderRequest): Promise<Fill>;
  fetchPrice(symbol: string): Promise<bigint>;
}

export class TradingVenueNotConfiguredError extends Error {
  constructor(venue: string) {
    super(`${venue} is not configured — populate KYB-gated secrets and set MOCK_TRADING_ENABLED=false`);
    this.name = 'TradingVenueNotConfiguredError';
  }
}
