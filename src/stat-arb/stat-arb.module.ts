import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockTradingVenue } from './mock-trading-venue';
import { RealBinanceVenue } from './real-binance-venue';
import { ITradingVenue, TRADING_VENUE } from './trading-venue.interface';
import { DemoService } from './demo/demo.service';
import { DemoController } from './demo/demo.controller';
import { DemoPageController } from './demo/demo-page.controller';

@Module({
  providers: [
    // Venue swap seam: mock-default; real Binance dormant until KYB completes.
    // Same pattern as HedgeModule's HEDGE_VENUE factory.
    {
      provide: TRADING_VENUE,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): ITradingVenue => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.statArb.mockEnabled ? new MockTradingVenue() : new RealBinanceVenue();
      },
    },
    DemoService,
  ],
  controllers: [DemoController, DemoPageController],
})
export class StatArbModule {}
