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
import { Bar } from './backtest/bar';
import { LivePaperTrader, WarmupProvider } from '../execution/live-paper-trader';
import { LivePortfolioTrader, PortfolioPair } from '../execution/live-portfolio-trader';
import { strategyRegistry } from './strategies/strategy-registry';
import { LiveController } from '../execution/live.controller';
import { RiskEngine } from './risk/risk-engine';
import { DrawdownGate } from './risk/drawdown-gate';

// Warm the live loop's rolling window from recent real Binance klines so a
// freshly-armed pair can trade on its first live bar instead of waiting ~an
// hour to accumulate a lookback window. Aligned to common timestamps per leg.
async function warmupFromBinance(
  client: BinancePublicClient,
  interval: string,
  symbolA: string,
  symbolB: string,
): Promise<{ a: Bar[]; b: Bar[] }> {
  const [a, b] = await Promise.all([
    client.klines(symbolA, interval, 240),
    client.klines(symbolB, interval, 240),
  ]);
  const bByTs = new Map(b.map((bar) => [bar.timestamp.getTime(), bar]));
  const outA: Bar[] = [];
  const outB: Bar[] = [];
  for (const barA of a) {
    const barB = bByTs.get(barA.timestamp.getTime());
    if (barB) {
      outA.push(barA);
      outB.push(barB);
    }
  }
  return { a: outA, b: outB };
}

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
      inject: [ConfigService, TRADING_VENUE, LIVE_FEED, StatArbRepository, BINANCE_CLIENT],
      useFactory: (
        cfg: ConfigService,
        venue: ITradingVenue,
        feed: IBarFeed,
        repo: StatArbRepository,
        client: BinancePublicClient,
      ): LivePaperTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        // A fresh strategy per pair from the desk registry: switching presaved
        // markets (or strategies) at runtime rebuilds with the discovered β and
        // the chosen catalogue id rather than carrying state across pairs.
        const makeStrategy = (opts: { beta?: number; strategyId?: string }) =>
          strategyRegistry.build(opts.strategyId ?? app.live.strategyId, {
            beta: opts.beta ?? app.live.beta,
            notionalUnits: app.live.notionalUnits,
          });
        const riskEngine = new RiskEngine({
          drawdown: new DrawdownGate({ maxDrawdownPct: app.live.maxDrawdownPct }),
        });
        const warmup: WarmupProvider | undefined =
          app.feed.source === 'binance'
            ? (a, b) => warmupFromBinance(client, app.feed.interval, a, b)
            : undefined;
        return new LivePaperTrader(
          makeStrategy({}),
          venue,
          feed,
          {
            symbolA: app.live.pairA,
            symbolB: app.live.pairB,
            strategyId: app.live.strategyId,
            pollIntervalMs: app.live.pollIntervalMs,
            autoStart: app.live.autoStart && app.feed.source === 'binance',
            riskEngine,
            capitalUnits: app.live.capitalUnits,
          },
          repo,
          undefined,
          (opts) => makeStrategy({ beta: opts.beta, strategyId: opts.strategyId }),
          warmup,
        );
      },
    },
    // Multi-currency desk: N pairs concurrently, each an ISOLATED paper book
    // (own feed cursor + venue + strategy) on the shared live data client.
    {
      provide: LivePortfolioTrader,
      inject: [ConfigService, BINANCE_CLIENT, PRICE_SOURCE, StatArbRepository],
      useFactory: (
        cfg: ConfigService,
        client: BinancePublicClient,
        price: IPriceSource,
        repo: StatArbRepository,
      ): LivePortfolioTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const makeStrategy = (beta?: number, strategyId?: string) =>
          strategyRegistry.build(strategyId ?? app.live.strategyId, {
            beta: beta ?? app.live.beta,
            notionalUnits: app.live.notionalUnits,
          });
        const makeTrader = (pair: PortfolioPair): LivePaperTrader => {
          const feed: IBarFeed =
            app.feed.source === 'binance'
              ? new BinancePublicBarFeed(client, app.feed.interval)
              : new MockBarFeed();
          const venue: ITradingVenue =
            app.execution.mode === 'mock'
              ? new MockTradingVenue()
              : new PaperVenue({
                  pricePoller: (s) => price.priceMicros(s),
                  slippage:
                    app.live.advUnits > 0n
                      ? { advUnits: app.live.advUnits, lambdaBps: app.live.slippageLambdaBps }
                      : undefined,
                });
          const riskEngine = new RiskEngine({
            drawdown: new DrawdownGate({ maxDrawdownPct: app.live.maxDrawdownPct }),
          });
          const warmup: WarmupProvider | undefined =
            app.feed.source === 'binance'
              ? (a, b) => warmupFromBinance(client, app.feed.interval, a, b)
              : undefined;
          return new LivePaperTrader(
            makeStrategy(pair.beta, pair.strategyId),
            venue,
            feed,
            {
              symbolA: pair.symbolA,
              symbolB: pair.symbolB,
              strategyId: pair.strategyId ?? app.live.strategyId,
              pollIntervalMs: app.live.pollIntervalMs,
              autoStart: false,
              riskEngine,
              capitalUnits: app.live.capitalUnits,
            },
            repo,
            undefined,
            (o) => makeStrategy(o.beta, o.strategyId),
            warmup,
          );
        };
        return new LivePortfolioTrader(makeTrader, app.live.pollIntervalMs, app.live.capitalUnits);
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
