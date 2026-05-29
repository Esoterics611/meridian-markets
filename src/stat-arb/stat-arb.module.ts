import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockTradingVenue } from './mock-trading-venue';
import { RealBinanceVenue } from './real-binance-venue';
import { ITradingVenue, TRADING_VENUE } from './trading-venue.interface';
import { IBarFeed, LIVE_FEED } from './feed/live-feed.interface';
import { MockBarFeed } from './feed/mock-bar-feed';
import { BinancePublicBarFeed } from './feed/binance-public-bar-feed';
import { BinancePublicClient, BINANCE_CLIENT } from './feed/binance-public-client';
import {
  BinancePriceSource,
  IPriceSource,
  PRICE_SOURCE,
  StaticPriceSource,
} from './feed/price-source';
import { DemoService } from './demo/demo.service';
import { DemoController } from './demo/demo.controller';
import { DemoPageController } from './demo/demo-page.controller';
import { StatArbRepository } from './persistence/stat-arb.repository';
import { StatArbNavCron } from './persistence/nav.cron';
import { ResearchController } from './research/research.controller';
import { ExecDemoService } from '../execution/exec-demo.service';
import { ExecController } from '../execution/exec.controller';
import { UniverseController } from './discovery/universe.controller';
import { PaperVenue } from '../execution/paper-venue';
import { PairsStrategy } from './backtest/pairs-strategy';
import { LivePaperTrader } from '../execution/live-paper-trader';
import { LiveController } from '../execution/live.controller';
import { RiskEngine } from './risk/risk-engine';
import { DrawdownGate } from './risk/drawdown-gate';

@Module({
  providers: [
    // Shared Binance public REST client (no key, public market data only).
    {
      provide: BINANCE_CLIENT,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): BinancePublicClient => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new BinancePublicClient({
          baseUrl: app.feed.binanceBaseUrl,
          quote: app.feed.quote,
        });
      },
    },
    // Market-data feed seam — real Binance public data or the synthetic mock.
    {
      provide: LIVE_FEED,
      inject: [ConfigService, BINANCE_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient): IBarFeed => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.feed.source === 'binance'
          ? new BinancePublicBarFeed(client, app.feed.interval)
          : new MockBarFeed();
      },
    },
    // Fill-price source for the paper matching engine.
    {
      provide: PRICE_SOURCE,
      inject: [ConfigService, BINANCE_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient): IPriceSource => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.feed.source === 'binance'
          ? new BinancePriceSource(client)
          : StaticPriceSource.fromMap({});
      },
    },
    // Execution venue seam, selected by EXECUTION_MODE:
    //   mock         -> synthetic venue
    //   paper/canary -> PaperVenue pegged to real prices
    //   live         -> real venue (armed via LIVE_TRADING_ARMED; dormant otherwise)
    {
      provide: TRADING_VENUE,
      inject: [ConfigService, PRICE_SOURCE],
      useFactory: (cfg: ConfigService, price: IPriceSource): ITradingVenue => {
        const app = cfg.getOrThrow<AppConfig>('app');
        switch (app.execution.mode) {
          case 'live':
            return new RealBinanceVenue();
          case 'paper':
          case 'canary':
            return new PaperVenue({
              pricePoller: (s) => price.priceMicros(s),
              // Model slippage only when an ADV is configured (else frictionless).
              slippage:
                app.live.advUnits > 0n
                  ? { advUnits: app.live.advUnits, lambdaBps: app.live.slippageLambdaBps }
                  : undefined,
            });
          default:
            return new MockTradingVenue();
        }
      },
    },
    // The live event loop: pairs strategy + venue + feed + persistence.
    {
      provide: LivePaperTrader,
      inject: [ConfigService, TRADING_VENUE, LIVE_FEED, StatArbRepository],
      useFactory: (
        cfg: ConfigService,
        venue: ITradingVenue,
        feed: IBarFeed,
        repo: StatArbRepository,
      ): LivePaperTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        // A fresh strategy per pair: switching presaved markets at runtime
        // rebuilds with the discovered β rather than carrying state across pairs.
        const makeStrategy = (opts: { beta?: number }) =>
          new PairsStrategy({
            beta: opts.beta ?? app.live.beta,
            zLookback: app.live.zLookback,
            entryZ: app.live.entryZ,
            exitZ: app.live.exitZ,
            notionalUnits: app.live.notionalUnits,
          });
        const riskEngine = new RiskEngine({
          drawdown: new DrawdownGate({ maxDrawdownPct: app.live.maxDrawdownPct }),
        });
        return new LivePaperTrader(
          makeStrategy({}),
          venue,
          feed,
          {
            symbolA: app.live.pairA,
            symbolB: app.live.pairB,
            pollIntervalMs: app.live.pollIntervalMs,
            autoStart: app.live.autoStart && app.feed.source === 'binance',
            riskEngine,
            capitalUnits: app.live.capitalUnits,
          },
          repo,
          undefined,
          (opts) => makeStrategy({ beta: opts.beta }),
        );
      },
    },
    DemoService,
    StatArbRepository,
    StatArbNavCron,
    ExecDemoService,
  ],
  controllers: [
    DemoController,
    DemoPageController,
    ResearchController,
    ExecController,
    UniverseController,
    LiveController,
  ],
})
export class StatArbModule {}
