import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { HedgeVenueUnhealthyError, VenueHealth } from './hedge-venue.interface';
import { FeedStaleError } from './hedge.errors';

// HedgeCircuitBreaker — enforces the three kill switches described in
// PHASED_PLAN.md §Phase 1 and PHASE_1_PROMPT.md §2.4. Injected into
// HedgeService and HedgeMonitorCron; checked before every hedge operation.
//
// All checks throw a typed error on violation — the cron catches, logs, and
// continues; HedgeService.openShort re-throws so the caller (the cron) knows
// to pause that tick. No silent swallowing inside this class.

@Injectable()
export class HedgeCircuitBreaker {
  private readonly maxFundingBps: number;
  private readonly maxFeedStalenessMs: number;
  private readonly ilsSigmaBps: number;

  constructor(cfg: ConfigService) {
    const app = cfg.getOrThrow<AppConfig>('app');
    this.maxFundingBps = app.hedge.maxFundingBps;
    this.maxFeedStalenessMs = app.hedge.maxFeedStalenessMs;
    this.ilsSigmaBps = app.hedge.ilsSigmaBps;
  }

  /**
   * Throws HedgeVenueUnhealthyError if the venue reports unhealthy or if the
   * most recent funding rate exceeds `maxFundingBps`. Called before every
   * openShort — we don't open new positions into a stressed market.
   */
  checkVenueHealth(health: VenueHealth): void {
    if (!health.healthy) {
      throw new HedgeVenueUnhealthyError(
        `venue reports unhealthy (as of ${health.lastUpdate.toISOString()})`,
      );
    }
    if (health.lastFundingBps > this.maxFundingBps) {
      throw new HedgeVenueUnhealthyError(
        `funding rate ${health.lastFundingBps} bps exceeds circuit-breaker max ${this.maxFundingBps} bps`,
      );
    }
  }

  /**
   * Throws FeedStaleError if the exposure snapshot is older than
   * `maxFeedStalenessMs`. The `now` parameter is injectable for testing.
   */
  checkFeedStaleness(asOf: Date, now: Date = new Date()): void {
    const ageMs = now.getTime() - asOf.getTime();
    if (ageMs > this.maxFeedStalenessMs) {
      throw new FeedStaleError(ageMs, this.maxFeedStalenessMs);
    }
  }

  /**
   * Returns the maximum hedge notional (USDC units) we should hold given
   * `marginUnits` of available margin, sized so a 3σ adverse ILS move
   * does not trigger a liquidation.
   *
   * Formula:  maxNotional = marginUnits × 10_000 / (3 × ilsSigmaBps)
   *
   * Example: marginUnits = 100 USDC (100_000_000 units), ilsSigmaBps = 94
   *   → maxNotional = 100_000_000 × 10_000 / (3 × 94)
   *                 ≈ 354 USDC worth of notional per 1 USDC of margin.
   * In practice the hedge exposure is sized to outstanding USDC, not margin,
   * but the caller MUST verify that the resulting notional satisfies this cap.
   */
  maxNotional(marginUnits: bigint): bigint {
    if (this.ilsSigmaBps <= 0) return marginUnits; // degenerate guard
    return (marginUnits * 10_000n) / (3n * BigInt(this.ilsSigmaBps));
  }
}
