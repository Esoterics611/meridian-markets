// Hedge-service-level errors — distinct from venue-level errors
// (HedgeVenueUnhealthyError etc.) which live in hedge-venue.interface.ts.

export class InvalidHedgeAmountError extends Error {
  constructor(amount: bigint) {
    super(`hedge: notional must be > 0; got ${amount.toString()}`);
    this.name = 'InvalidHedgeAmountError';
  }
}

export class FeedStaleError extends Error {
  constructor(ageMs: number, maxMs: number) {
    super(
      `exposure feed is stale: age=${ageMs}ms exceeds max=${maxMs}ms — hedging paused until feed recovers`,
    );
    this.name = 'FeedStaleError';
  }
}
