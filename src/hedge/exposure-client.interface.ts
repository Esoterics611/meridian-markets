// IExposureClient — the single sanctioned read from Lira-Bridge's outstanding
// Path C ILS exposure. The real implementation calls the Lira-Bridge endpoint
// `GET /api/path-c/outstanding-exposure` (documented in
// docs/INTEGRATION_WITH_LIRA_BRIDGE.md §9).
//
// StubExposureClient returns a fixed configurable amount — same mock-default
// discipline as IYieldProvider / IHedgeVenue. The real LiraBridgeExposureClient
// is a separate session in the Lira-Bridge repo.
//
// First-party only. Never exposed as a customer endpoint. See PHASED_PLAN.md
// §Phase 1 and CLAUDE.md §§6+7 (binding modular-monolith rules).

export const EXPOSURE_CLIENT = Symbol('EXPOSURE_CLIENT');

export interface OutstandingExposure {
  /** Outstanding ILS amount in 6-decimal integer units (1 ILS = 1_000_000 units). */
  ilsUnits: bigint;
  /** Equivalent USDC value in 6-decimal integer units (1 USDC = 1_000_000 units). */
  usdcUnits: bigint;
  /** Timestamp when the Lira-Bridge source computed this figure. Used for staleness checks. */
  asOf: Date;
}

export interface IExposureClient {
  getOutstandingExposure(): Promise<OutstandingExposure>;
}

// StubExposureClient — deterministic, zero network calls, same posture as
// MockYieldProvider. Default exposure: 500 000 USDC (500_000_000_000 units),
// representing a mid-sized Path C pipeline batch. Override in tests by
// constructing with a different fixedUsdcUnits.
//
// ILS/USDC rate: approximated at 3.7 ILS per USD (rounded ratio for the mock).
export class StubExposureClient implements IExposureClient {
  constructor(
    private readonly fixedUsdcUnits: bigint = 500_000_000_000n,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOutstandingExposure(): Promise<OutstandingExposure> {
    return {
      // 3.7 ILS per USD ≈ 37 ILS units per 10 USDC units (rough ratio for mock)
      ilsUnits: (this.fixedUsdcUnits * 37n) / 10n,
      usdcUnits: this.fixedUsdcUnits,
      asOf: this.now(),
    };
  }
}
