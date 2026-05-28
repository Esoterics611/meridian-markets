import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockTradingVenue } from './mock-trading-venue';
import { RealBinanceVenue } from './real-binance-venue';
import { ITradingVenue, TRADING_VENUE } from './trading-venue.interface';
import { IBarFeed, LIVE_FEED } from './feed/live-feed.interface';
import { MockBarFeed } from './feed/mock-bar-feed';
import { RealCcxtBarFeed } from './feed/real-ccxt-feed';
import { DemoService } from './demo/demo.service';
import { DemoController } from './demo/demo.controller';
import { DemoPageController } from './demo/demo-page.controller';
import { StatArbRepository } from './persistence/stat-arb.repository';
import { StatArbNavCron } from './persistence/nav.cron';
import { ResearchController } from './research/research.controller';
import { ExecDemoService } from '../execution/exec-demo.service';
import { ExecController } from '../execution/exec.controller';

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
    // Live-feed swap seam: mirrors TRADING_VENUE. Shares the statArb.mockEnabled
    // flag — real venues and real feeds are flipped together at KYB close.
    {
      provide: LIVE_FEED,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): IBarFeed => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.statArb.mockEnabled ? new MockBarFeed() : new RealCcxtBarFeed();
      },
    },
    DemoService,
    StatArbRepository,
    StatArbNavCron,
    ExecDemoService,
  ],
  controllers: [DemoController, DemoPageController, ResearchController, ExecController],
})
export class StatArbModule {}
