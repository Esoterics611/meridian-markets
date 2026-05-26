// IHedgeVenue is the swap interface — same pattern as IYieldProvider, the
// IBridgeApiClient family in Lira-Bridge, and the IReservePool seam. Consumers
// depend on this only; the concrete (Mock vs Hyperliquid vs Drift vs GMX) is
// selected once in HedgeModule's factory based on MOCK_HEDGE_ENABLED.
//
// Scope: Phase 1 FX hedge — opens short-ILS positions to neutralise Lira-Bridge
// Path C exposure during the wire-settlement window. First-party only. Never
// customer-facing. See PHASED_PLAN.md §Phase 1.

export const HEDGE_VENUE = Symbol('HEDGE_VENUE');

// Notional is in 6-decimal USDC units (1 USDC = 1_000_000), same convention as
// IYieldProvider. Prices are quoted in micros (1e6) of ILS-per-USD — storing
// integer micros keeps bigint arithmetic exact across the codebase.
export interface OpenShortRequest {
  notionalUnits: bigint;
  idempotencyKey: string;
}

export interface OpenShortResult {
  externalRef: string;
  filledNotionalUnits: bigint;
  entryPriceMicros: bigint;
}

export interface CloseShortRequest {
  positionRef: string;
  idempotencyKey: string;
}

export interface CloseShortResult {
  externalRef: string;
  /** Signed: positive = short paid off (ILS weakened vs USD). */
  pnlUnits: bigint;
}

export interface HedgePosition {
  positionRef: string;
  notionalUnits: bigint;
  entryPriceMicros: bigint;
  markPriceMicros: bigint;
  /** Signed; same sign convention as CloseShortResult.pnlUnits. */
  unrealizedPnlUnits: bigint;
  fundingPaidUnits: bigint;
  asOf: Date;
}

export interface VenueHealth {
  healthy: boolean;
  /** Last observed funding rate in basis points (1 bp = 0.01%). */
  lastFundingBps: number;
  lastUpdate: Date;
}

export interface IHedgeVenue {
  /** Stable identifier — written into future hedge_movements.venue column. */
  readonly venueId: string;

  openShort(req: OpenShortRequest): Promise<OpenShortResult>;
  closeShort(req: CloseShortRequest): Promise<CloseShortResult>;

  fetchPosition(positionRef: string): Promise<HedgePosition>;
  fetchHealth(): Promise<VenueHealth>;
}

export class HedgeVenueNotConfiguredError extends Error {
  constructor(venue: string) {
    super(`${venue} is not configured — populate KYB-gated secrets and set MOCK_HEDGE_ENABLED=false`);
    this.name = 'HedgeVenueNotConfiguredError';
  }
}

export class HedgeVenueUnhealthyError extends Error {
  constructor(reason: string) {
    super(`hedge venue unhealthy: ${reason}`);
    this.name = 'HedgeVenueUnhealthyError';
  }
}

export class HedgeVenueInsufficientMarginError extends Error {
  constructor(requestedUnits: bigint, availableUnits: bigint) {
    super(`hedge venue has insufficient margin: requested=${requestedUnits} available=${availableUnits}`);
    this.name = 'HedgeVenueInsufficientMarginError';
  }
}

export class HedgePositionNotFoundError extends Error {
  constructor(positionRef: string) {
    super(`hedge position not found: ${positionRef}`);
    this.name = 'HedgePositionNotFoundError';
  }
}
