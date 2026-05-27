import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { HEDGE_VENUE, IHedgeVenue } from './hedge-venue.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { HedgeService } from './hedge.service';
import { EXPOSURE_CLIENT, IExposureClient } from './exposure-client.interface';

// HedgeMonitorCron — polls Lira-Bridge's outstanding Path C ILS exposure and
// rebalances the open short-ILS hedge position when the imbalance exceeds the
// configured threshold. Also triggers `HedgeService.markAll()` to keep
// position marks fresh.
//
// Circuit-breaker interactions:
//   - If the exposure feed is stale → FeedStaleError → logged, tick skipped.
//   - If the venue is unhealthy or funding spikes → HedgeVenueUnhealthyError
//     → logged, tick skipped. Positions are NOT force-closed on a health event
//     (that would require a more complex saga; flagged for Phase 1 hardening).
//
// Rebalance logic (v1 — simple, single position):
//   - Under-hedged by > rebalanceThresholdPct: open one new short for the delta.
//   - Over-hedged  by > rebalanceThresholdPct: close all open positions, then
//     re-open at target notional. "Nuke-and-pave" is operationally simple and
//     correct; a smarter partial-close optimisation is a later session.
//
// Plain setInterval — same posture as YieldSyncCron.
@Injectable()
export class HedgeMonitorCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HedgeMonitorCron.name);
  private handle: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly hedgeService: HedgeService,
    private readonly breaker: HedgeCircuitBreaker,
    @Inject(EXPOSURE_CLIENT) private readonly exposureClient: IExposureClient,
    @Inject(HEDGE_VENUE) private readonly venue: IHedgeVenue,
  ) {}

  onModuleInit(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive tick() explicitly
    const intervalMs = app.hedge.monitorIntervalMs;
    this.handle = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`hedge monitor started: every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  /** Public so tests can drive it explicitly without real timers. */
  async tick(): Promise<void> {
    try {
      await this.rebalance();
      await this.hedgeService.markAll();
    } catch (err) {
      // Circuit-breaker fires land here as well as any unexpected errors.
      // Log and let the next tick retry — do not escalate.
      this.logger.error(`hedge-monitor tick failed: ${(err as Error).message}`);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async rebalance(): Promise<void> {
    const app = this.cfg.getOrThrow<AppConfig>('app');

    // 1. Fetch exposure + check staleness.
    const exposure = await this.exposureClient.getOutstandingExposure();
    this.breaker.checkFeedStaleness(exposure.asOf); // throws FeedStaleError if stale

    // 2. Check venue health.
    const health = await this.venue.fetchHealth();
    this.breaker.checkVenueHealth(health); // throws HedgeVenueUnhealthyError if tripped

    // 3. Current hedge state.
    const currentNotional = await this.hedgeService.getTotalOpenNotional();

    // 4. Target notional (hedgeRatioPct% of outstanding USDC exposure).
    const targetNotional =
      (exposure.usdcUnits * BigInt(app.hedge.hedgeRatioPct)) / 100n;

    // 5. No exposure at all — close any open positions and exit.
    if (targetNotional === 0n) {
      if (currentNotional > 0n) {
        await this.closeAll('zero-exposure');
      }
      return;
    }

    // 6. Imbalance check.
    const delta = targetNotional - currentNotional; // positive = under-hedged
    const thresholdUnits =
      (targetNotional * BigInt(app.hedge.rebalanceThresholdPct)) / 100n;

    if (delta > thresholdUnits) {
      // Under-hedged by more than threshold → open a short for the delta.
      const key = `monitor-open-${Date.now()}`;
      await this.hedgeService.openShort(delta, key);
      this.logger.log(
        `hedge monitor: opened short ${delta.toString()} units (target=${targetNotional} current=${currentNotional})`,
      );
    } else if (-delta > thresholdUnits) {
      // Over-hedged → nuke-and-pave: close all, re-open at target.
      await this.closeAll('over-hedged');
      if (targetNotional > 0n) {
        const key = `monitor-open-repave-${Date.now()}`;
        await this.hedgeService.openShort(targetNotional, key);
        this.logger.log(
          `hedge monitor: repaved to ${targetNotional.toString()} units`,
        );
      }
    }
    // else: within threshold — no action needed.
  }

  private async closeAll(reason: string): Promise<void> {
    const refs = await this.hedgeService.listOpenPositionRefs();
    for (const ref of refs) {
      const key = `monitor-close-${ref}-${Date.now()}`;
      await this.hedgeService.closeShort(ref, key);
      this.logger.log(`hedge monitor: closed ${ref} (reason: ${reason})`);
    }
  }
}
