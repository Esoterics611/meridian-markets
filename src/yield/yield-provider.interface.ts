// IYieldProvider is the swap interface — same pattern as Lira-Bridge's
// IBridgeApiClient, IOnRampAdapter, IReservePool. Consumers depend on this
// only; the concrete (Mock vs Ondo vs sDAI vs BUIDL) is selected once in
// YieldModule's factory based on MOCK_YIELD_ENABLED.

export const YIELD_PROVIDER = Symbol('YIELD_PROVIDER');

// All amounts are in 6-decimal USDC units. 1 USDC = 1_000_000.
export interface DepositRequest {
  amountUnits: bigint;
  idempotencyKey: string;
}

export interface DepositResult {
  externalRef: string;
  acceptedUnits: bigint;
}

export interface WithdrawRequest {
  amountUnits: bigint;
  idempotencyKey: string;
}

export interface WithdrawResult {
  externalRef: string;
  releasedUnits: bigint;
}

export interface YieldPosition {
  principalUnits: bigint;
  yieldEarnedUnits: bigint;
  asOf: Date;
}

export interface IYieldProvider {
  /** Stable identifier — written into treasury_movements.provider. */
  readonly providerId: string;

  deposit(req: DepositRequest): Promise<DepositResult>;
  withdraw(req: WithdrawRequest): Promise<WithdrawResult>;

  /** Snapshot the provider-side position. Drives YIELD_ACCRUAL movements. */
  fetchPosition(): Promise<YieldPosition>;
}

export class YieldProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured — populate KYB-gated secrets and set MOCK_YIELD_ENABLED=false`);
    this.name = 'YieldProviderNotConfiguredError';
  }
}

export class YieldProviderInsufficientError extends Error {
  constructor(requested: bigint, available: bigint) {
    super(`yield provider has insufficient principal: requested=${requested} available=${available}`);
    this.name = 'YieldProviderInsufficientError';
  }
}
