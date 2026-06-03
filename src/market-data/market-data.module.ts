import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MarketDataRepository } from './market-data.repository';
import { ReplayEngine } from './replay/replay-engine';
import { BAR_INGEST, IBarIngest } from './ingest/bar-ingest.interface';
import { MockBarIngest } from './ingest/mock-bar-ingest';
import { CcxtBarIngest } from './ingest/ccxt-bar-ingest';
import { BinanceBackfillService } from './ingest/binance-backfill.service';
import { BinancePublicClient, BINANCE_CLIENT } from '../stat-arb/feed/binance-public-client';
import { MarketDataController } from './market-data.controller';
import { ReferenceSourceRegistry, buildReferenceSources } from './reference/reference-bar-loader';

// MarketDataModule — ingest + replay for the trading engine.
//
// INTERIM scope: enough real-bar ingest (Binance public history) for the
// engine to backtest on real data. The full market-data platform is a
// SEPARATE repo (see CLAUDE.md §1); meridian-markets will consume it over a
// contract rather than growing it in-process.

@Module({
  providers: [
    MarketDataRepository,
    ReplayEngine,
    MockBarIngest,
    CcxtBarIngest,
    BinanceBackfillService,
    {
      // Shared public REST client (no key). Mirrors StatArbModule's provider.
      provide: BINANCE_CLIENT,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): BinancePublicClient => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new BinancePublicClient({ baseUrl: app.feed.binanceBaseUrl, quote: app.feed.quote });
      },
    },
    {
      provide: BAR_INGEST,
      inject: [ConfigService, MockBarIngest, CcxtBarIngest],
      useFactory: (cfg: ConfigService, mock: MockBarIngest, real: CcxtBarIngest): IBarIngest => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.statArb.mockEnabled ? mock : real;
      },
    },
    {
      // Reference-data sources (TESSERA): Pyth FX / DefiLlama peg / Bit2C ILS.
      provide: ReferenceSourceRegistry,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): ReferenceSourceRegistry => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new ReferenceSourceRegistry(
          buildReferenceSources({
            pythBaseUrl: app.feed.pythBaseUrl,
            defillamaBaseUrl: app.feed.defillamaBaseUrl,
            bit2cBaseUrl: app.feed.bit2cBaseUrl,
            geckoTerminalBaseUrl: app.feed.geckoTerminalBaseUrl,
            hyperliquidBaseUrl: app.feed.hyperliquidBaseUrl,
          }),
        );
      },
    },
  ],
  controllers: [MarketDataController],
  exports: [MarketDataRepository, ReplayEngine, BAR_INGEST, MockBarIngest, BinanceBackfillService],
})
export class MarketDataModule {}
