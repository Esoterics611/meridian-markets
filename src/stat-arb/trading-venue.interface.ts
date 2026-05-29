// ITradingVenue is the execution swap seam for the stat-arb engine. Consumers
// depend on this interface only; the concrete implementation is selected in
// StatArbModule's factory by EXECUTION_MODE:
//   mock          -> MockTradingVenue   (synthetic, offline)
//   paper/canary  -> PaperVenue         (real prices, simulated fills)
//   live          -> a real venue       (armed via LIVE_TRADING_ARMED)
//
// Paper and live share this same interface and the same upstream loop, so
// paper results predict live behaviour.

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
    super(`${venue} is not configured — wire its credentials and set LIVE_TRADING_ARMED=true`);
    this.name = 'TradingVenueNotConfiguredError';
  }
}
