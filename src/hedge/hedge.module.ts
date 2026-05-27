import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockHedgeVenue } from './mock-hedge-venue';
import { RealHyperliquidHedgeVenue } from './real-hyperliquid-hedge-venue';
import { HEDGE_VENUE, IHedgeVenue } from './hedge-venue.interface';
import { StubExposureClient } from './exposure-client.interface';
import { EXPOSURE_CLIENT } from './exposure-client.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { HedgeService } from './hedge.service';
import { HedgeMonitorCron } from './hedge-monitor.cron';

@Module({
  providers: [
    // ── Venue swap seam (mock-default, real gated behind KYB) ─────────────
    {
      provide: HEDGE_VENUE,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): IHedgeVenue => {
        const app = cfg.getOrThrow<AppConfig>('app');
        if (app.hedge.mockEnabled) {
          return new MockHedgeVenue(app.hedge.mockFxDriftBpsPerDay, app.hedge.mockSettleMs);
        }
        return new RealHyperliquidHedgeVenue();
      },
    },

    // ── Exposure client (stub until Lira-Bridge implements the endpoint) ──
    // Real implementation is a separate session in /home/nexus/code/meridian.
    // See docs/INTEGRATION_WITH_LIRA_BRIDGE.md §9.
    {
      provide: EXPOSURE_CLIENT,
      useValue: new StubExposureClient(),
    },

    // ── Orchestration layer ───────────────────────────────────────────────
    HedgeCircuitBreaker,
    HedgeService,
    HedgeMonitorCron,
  ],
  exports: [HedgeService],
})
export class HedgeModule {}
