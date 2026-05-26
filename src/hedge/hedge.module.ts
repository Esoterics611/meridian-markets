import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockHedgeVenue } from './mock-hedge-venue';
import { RealHyperliquidHedgeVenue } from './real-hyperliquid-hedge-venue';
import { HEDGE_VENUE, IHedgeVenue } from './hedge-venue.interface';

@Module({
  providers: [
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
  ],
  exports: [HEDGE_VENUE],
})
export class HedgeModule {}
