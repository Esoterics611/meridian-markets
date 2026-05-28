import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MarketDataRepository } from './market-data.repository';
import { ReplayEngine } from './replay/replay-engine';
import { BAR_INGEST, IBarIngest } from './ingest/bar-ingest.interface';
import { MockBarIngest } from './ingest/mock-bar-ingest';
import { CcxtBarIngest } from './ingest/ccxt-bar-ingest';

// MarketDataModule — Phase 3 ingest + replay. Same mock-default posture as
// every other external-IO module: MockBarIngest unless statArb.mockEnabled
// is false, in which case the dormant CcxtBarIngest is selected and will
// throw on every call.

@Module({
  providers: [
    MarketDataRepository,
    ReplayEngine,
    MockBarIngest,
    CcxtBarIngest,
    {
      provide: BAR_INGEST,
      inject: [ConfigService, MockBarIngest, CcxtBarIngest],
      useFactory: (cfg: ConfigService, mock: MockBarIngest, real: CcxtBarIngest): IBarIngest => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.statArb.mockEnabled ? mock : real;
      },
    },
  ],
  exports: [MarketDataRepository, ReplayEngine, BAR_INGEST, MockBarIngest],
})
export class MarketDataModule {}
