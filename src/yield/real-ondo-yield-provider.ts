import { Injectable } from '@nestjs/common';
import {
  DepositRequest,
  DepositResult,
  IYieldProvider,
  WithdrawRequest,
  WithdrawResult,
  YieldPosition,
  YieldProviderNotConfiguredError,
} from './yield-provider.interface';

// Real Ondo USDY provider — DORMANT in Phase 0.
//
// Wire-up plan (post-KYB):
//   - deposit  → POST /v1/institutional/usdy/mint   { amount }
//   - withdraw → POST /v1/institutional/usdy/redeem { amount }
//   - position → GET  /v1/institutional/positions/usdy
//
// USDY uses a rebase mechanism: balance grows over time, so principal vs.
// yield is computed by snapshotting balance and treating Δbalance since the
// last DEPOSIT/WITHDRAW as accrued yield.
//
// Throws YieldProviderNotConfiguredError until MOCK_YIELD_ENABLED=false AND
// all ONDO_* secrets are populated. KYB onboarding with Ondo is a business
// gate — do not flip until that's done.

@Injectable()
export class RealOndoYieldProvider implements IYieldProvider {
  readonly providerId = 'ondo-usdy';

  async deposit(_req: DepositRequest): Promise<DepositResult> {
    throw new YieldProviderNotConfiguredError(this.providerId);
  }

  async withdraw(_req: WithdrawRequest): Promise<WithdrawResult> {
    throw new YieldProviderNotConfiguredError(this.providerId);
  }

  async fetchPosition(): Promise<YieldPosition> {
    throw new YieldProviderNotConfiguredError(this.providerId);
  }
}
