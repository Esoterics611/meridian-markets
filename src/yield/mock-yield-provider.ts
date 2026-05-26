import { Injectable } from '@nestjs/common';
import {
  DepositRequest,
  DepositResult,
  IYieldProvider,
  WithdrawRequest,
  WithdrawResult,
  YieldPosition,
  YieldProviderInsufficientError,
} from './yield-provider.interface';

// Deterministic mock — simulates principal + continuous yield accrual at a
// configurable APR. No external network calls. The real Ondo provider has
// the same surface, so swapping is a one-line factory change.
//
// Yield model: simple time-weighted accrual on the principal vector
//   yield = Σ_i principal_i * (Δt_i / YEAR_MS) * apr
// where the principal vector changes at every deposit / withdraw. Crude but
// adequate for exercising the verification path; the real provider will
// report the position authoritatively.

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface PrincipalSegment {
  units: bigint;
  startMs: number;
}

@Injectable()
export class MockYieldProvider implements IYieldProvider {
  readonly providerId = 'mock';

  private principal: bigint = 0n;
  // Earned yield "crystallised" up to lastTouchedMs. We add the time-weighted
  // accrual of the current principal between [lastTouchedMs, now()] on each
  // read or mutation.
  private crystallisedYield: bigint = 0n;
  private lastTouchedMs: number;
  private readonly seenIdempotencyKeys = new Map<string, DepositResult | WithdrawResult>();

  constructor(
    private readonly apr: number,
    private readonly settleMs: number,
    /** Injectable clock so tests can fake time without jest fake timers. */
    private readonly now: () => number = Date.now,
  ) {
    this.lastTouchedMs = this.now();
  }

  async deposit(req: DepositRequest): Promise<DepositResult> {
    const cached = this.seenIdempotencyKeys.get(req.idempotencyKey);
    if (cached) return cached as DepositResult;

    await this.simulateLatency();
    this.crystallise();
    this.principal += req.amountUnits;

    const result: DepositResult = {
      externalRef: `mock-dep-${req.idempotencyKey}`,
      acceptedUnits: req.amountUnits,
    };
    this.seenIdempotencyKeys.set(req.idempotencyKey, result);
    return result;
  }

  async withdraw(req: WithdrawRequest): Promise<WithdrawResult> {
    const cached = this.seenIdempotencyKeys.get(req.idempotencyKey);
    if (cached) return cached as WithdrawResult;

    await this.simulateLatency();
    this.crystallise();
    if (req.amountUnits > this.principal) {
      throw new YieldProviderInsufficientError(req.amountUnits, this.principal);
    }
    this.principal -= req.amountUnits;

    const result: WithdrawResult = {
      externalRef: `mock-wd-${req.idempotencyKey}`,
      releasedUnits: req.amountUnits,
    };
    this.seenIdempotencyKeys.set(req.idempotencyKey, result);
    return result;
  }

  async fetchPosition(): Promise<YieldPosition> {
    this.crystallise();
    return {
      principalUnits: this.principal,
      yieldEarnedUnits: this.crystallisedYield,
      asOf: new Date(this.lastTouchedMs),
    };
  }

  private crystallise(): void {
    const now = this.now();
    const elapsedMs = now - this.lastTouchedMs;
    if (elapsedMs > 0 && this.principal > 0n && this.apr > 0) {
      // accrued = principal * apr * elapsedMs / YEAR_MS
      // Compute in BigInt with 1e12 scaling to avoid float drift on large
      // principals while keeping arithmetic exact.
      const scale = 1_000_000_000_000n;
      const rateScaled = BigInt(Math.round(this.apr * Number(scale)));
      const elapsed = BigInt(elapsedMs);
      const year = BigInt(YEAR_MS);
      const accrued = (this.principal * rateScaled * elapsed) / (scale * year);
      this.crystallisedYield += accrued;
    }
    this.lastTouchedMs = now;
  }

  private async simulateLatency(): Promise<void> {
    if (this.settleMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
  }
}
