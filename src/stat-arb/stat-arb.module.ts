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
import { AlpacaDataClient, ALPACA_CLIENT } from './feed/alpaca/alpaca-data-client';
import { AlpacaBarFeed } from './feed/alpaca/alpaca-bar-feed';
import { AlpacaPriceSource } from './feed/alpaca/alpaca-price-source';
import { AlpacaPaperVenue } from './feed/alpaca/alpaca-paper-venue';
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
import { OpportunityScanner } from './discovery/opportunity-scanner';
import { OpportunityController } from './discovery/opportunity.controller';
import { barsPerDayForInterval } from './discovery/net-edge-scorer';
import { MARKET_PRESETS, EQUITY_PRESETS } from './markets/market-presets';
import {
  ReferenceSourceRegistry,
  makeScannerLoader,
  buildReferenceSources,
} from '../market-data/reference/reference-bar-loader';
import { REFERENCE_PRESETS } from '../market-data/reference/reference-presets';
import {
  ReferenceBarFeed,
  ReferencePriceSource,
  warmupFromReference,
} from '../market-data/reference/reference-bar-feed';
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

// Equities warmup — same shape as warmupFromBinance, but from Alpaca's recent
// (session-only, split/dividend-adjusted) bars. alignMany via the common-
// timestamp intersection so a cross-leg session-bounded pair lines up.
async function warmupFromAlpaca(
  client: AlpacaDataClient,
  interval: string,
  symbolA: string,
  symbolB: string,
): Promise<{ a: Bar[]; b: Bar[] }> {
  const [a, b] = await Promise.all([
    client.recentBars(symbolA, interval, 240),
    client.recentBars(symbolB, interval, 240),
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
    // Shared Alpaca equities client (FEED_SOURCE=alpaca). Authenticated public
    // market data + paper venue. Dormant/unkeyed until ALPACA_* secrets exist;
    // the client throws before any wire call if used unkeyed.
    {
      provide: ALPACA_CLIENT,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): AlpacaDataClient => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new AlpacaDataClient({
          keyId: app.alpaca.keyId,
          secret: app.alpaca.secret,
          dataBaseUrl: app.alpaca.dataBaseUrl,
          feed: app.alpaca.dataFeed,
        });
      },
    },
    // Market-data feed seam — real Binance public data, real Alpaca equities,
    // or the synthetic mock.
    {
      provide: LIVE_FEED,
      inject: [ConfigService, BINANCE_CLIENT, ALPACA_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient, alpaca: AlpacaDataClient): IBarFeed => {
        const app = cfg.getOrThrow<AppConfig>('app');
        if (app.feed.source === 'binance') return new BinancePublicBarFeed(client, app.feed.interval);
        if (app.feed.source === 'alpaca') return new AlpacaBarFeed(alpaca, app.feed.interval, app.alpaca.dataFeed);
        return new MockBarFeed();
      },
    },
    // Fill-price source for the paper matching engine.
    {
      provide: PRICE_SOURCE,
      inject: [ConfigService, BINANCE_CLIENT, ALPACA_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient, alpaca: AlpacaDataClient): IPriceSource => {
        const app = cfg.getOrThrow<AppConfig>('app');
        if (app.feed.source === 'binance') return new BinancePriceSource(client);
        if (app.feed.source === 'alpaca') return new AlpacaPriceSource(alpaca);
        return StaticPriceSource.fromMap({});
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
            // Equities paper-trade against Alpaca's real paper API (server-side
            // fills, market-hours/halt validation); crypto uses the local
            // simulated PaperVenue pegged to the real price source.
            if (app.feed.source === 'alpaca') {
              return new AlpacaPaperVenue({
                keyId: app.alpaca.keyId,
                secret: app.alpaca.secret,
                tradingBaseUrl: app.alpaca.tradingBaseUrl,
                priceMicros: (s) => price.priceMicros(s),
              });
            }
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
      inject: [ConfigService, TRADING_VENUE, LIVE_FEED, StatArbRepository, BINANCE_CLIENT, ALPACA_CLIENT],
      useFactory: (
        cfg: ConfigService,
        venue: ITradingVenue,
        feed: IBarFeed,
        repo: StatArbRepository,
        client: BinancePublicClient,
        alpaca: AlpacaDataClient,
      ): LivePaperTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        // A fresh strategy per pair from the desk registry: switching presaved
        // markets (or strategies) at runtime rebuilds with the discovered β and
        // the chosen catalogue id rather than carrying state across pairs.
        const makeStrategy = (opts: { beta?: number; strategyId?: string; params?: Record<string, number> }) =>
          strategyRegistry.build(opts.strategyId ?? app.live.strategyId, {
            beta: opts.beta ?? app.live.beta,
            notionalUnits: app.live.notionalUnits,
            params: opts.params,
          });
        const riskEngine = new RiskEngine({
          drawdown: new DrawdownGate({ maxDrawdownPct: app.live.maxDrawdownPct }),
        });
        const warmup: WarmupProvider | undefined =
          app.feed.source === 'binance'
            ? (a, b) => warmupFromBinance(client, app.feed.interval, a, b)
            : app.feed.source === 'alpaca'
              ? (a, b) => warmupFromAlpaca(alpaca, app.feed.interval, a, b)
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
          (opts) => makeStrategy({ beta: opts.beta, strategyId: opts.strategyId, params: opts.params }),
          warmup,
        );
      },
    },
    // Multi-currency desk: N pairs concurrently, each an ISOLATED paper book
    // (own feed cursor + venue + strategy) on the shared live data client.
    {
      provide: LivePortfolioTrader,
      inject: [ConfigService, BINANCE_CLIENT, PRICE_SOURCE, StatArbRepository, ReferenceSourceRegistry, ALPACA_CLIENT],
      useFactory: (
        cfg: ConfigService,
        client: BinancePublicClient,
        price: IPriceSource,
        repo: StatArbRepository,
        refRegistry: ReferenceSourceRegistry,
        alpaca: AlpacaDataClient,
      ): LivePortfolioTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const makeStrategy = (beta?: number, strategyId?: string, params?: Record<string, number>, notionalUnits?: bigint) =>
          strategyRegistry.build(strategyId ?? app.live.strategyId, {
            beta: beta ?? app.live.beta,
            notionalUnits: notionalUnits ?? app.live.notionalUnits,
            params,
          });
        const makeTrader = (pair: PortfolioPair): LivePaperTrader => {
          // Per-leg trade notional ("lot size") chosen at launch; falls back to
          // the config default. Captured per book so reconfigure keeps the size.
          const bookNotional = pair.notionalUnits ?? app.live.notionalUnits;
          // A reference-source pair (e.g. Pyth FX) trades on a per-source feed +
          // price source so it rides the same live loop as a Binance pair.
          // 'binance'/'alpaca' are NOT reference sources — they ride the global
          // feed-source path below.
          const refSrc =
            pair.source && pair.source !== 'binance' && pair.source !== 'alpaca'
              ? refRegistry.get(pair.source)
              : undefined;
          const isAlpaca = !refSrc && app.feed.source === 'alpaca';
          const feed: IBarFeed = refSrc
            ? new ReferenceBarFeed(refSrc, app.feed.interval)
            : isAlpaca
              ? new AlpacaBarFeed(alpaca, app.feed.interval, app.alpaca.dataFeed)
              : app.feed.source === 'binance'
                ? new BinancePublicBarFeed(client, app.feed.interval)
                : new MockBarFeed();
          const priceSource: IPriceSource = refSrc
            ? new ReferencePriceSource(refSrc, app.feed.interval)
            : isAlpaca
              ? new AlpacaPriceSource(alpaca)
              : price;
          const venue: ITradingVenue =
            app.execution.mode === 'mock'
              ? new MockTradingVenue()
              : isAlpaca
                ? new AlpacaPaperVenue({
                    keyId: app.alpaca.keyId,
                    secret: app.alpaca.secret,
                    tradingBaseUrl: app.alpaca.tradingBaseUrl,
                    priceMicros: (s) => priceSource.priceMicros(s),
                  })
                : new PaperVenue({
                    pricePoller: (s) => priceSource.priceMicros(s),
                    slippage:
                      app.live.advUnits > 0n
                        ? { advUnits: app.live.advUnits, lambdaBps: app.live.slippageLambdaBps }
                        : undefined,
                  });
          const riskEngine = new RiskEngine({
            drawdown: new DrawdownGate({ maxDrawdownPct: app.live.maxDrawdownPct }),
          });
          const warmup: WarmupProvider | undefined = refSrc
            ? (a, b) => warmupFromReference(refSrc, app.feed.interval, a, b)
            : isAlpaca
              ? (a, b) => warmupFromAlpaca(alpaca, app.feed.interval, a, b)
              : app.feed.source === 'binance'
                ? (a, b) => warmupFromBinance(client, app.feed.interval, a, b)
                : undefined;
          return new LivePaperTrader(
            makeStrategy(pair.beta, pair.strategyId, pair.params, bookNotional),
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
            (o) => makeStrategy(o.beta, o.strategyId, o.params, bookNotional),
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
    // Reference-data sources (TESSERA): Pyth FX OHLC, DefiLlama peg, Bit2C ILS.
    // Stateless public HTTP clients — a per-module instance mirrors the
    // duplicated BINANCE_CLIENT provider pattern.
    {
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
    // Cross-asset opportunity scanner: ranks every preset's pairs by expected
    // net-edge-after-fees per day (the "scan wide, trade rarely" board). Sweeps
    // the Binance MARKET_PRESETS, the reference-source presets (Pyth FX), and —
    // when an Alpaca key is configured — the US-equity EQUITY_PRESETS, routing
    // each preset's symbols to its data source. The equity presets are key-gated
    // so a no-key deployment scans exactly as before (no 401 churn). NOTE: the
    // scanner is intraday-tuned (app.feed.interval, short half-life); it's a
    // coarse first look for equities — the real structural verdict comes from
    // scripts/cointegration-stability.ts + scripts/oos-candidates.ts.
    {
      provide: OpportunityScanner,
      inject: [ConfigService, BINANCE_CLIENT, ALPACA_CLIENT, ReferenceSourceRegistry],
      useFactory: (
        cfg: ConfigService,
        client: BinancePublicClient,
        alpaca: AlpacaDataClient,
        refRegistry: ReferenceSourceRegistry,
      ): OpportunityScanner => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const barsToLoad = 240;
        const hasAlpacaKey = Boolean(app.alpaca.keyId);
        const presets = [
          ...MARKET_PRESETS.map((p) => ({ id: p.id, label: p.label, assetClass: p.assetClass, symbols: [...p.symbols] })),
          ...REFERENCE_PRESETS.map((p) => ({ id: p.id, label: p.label, assetClass: p.assetClass, symbols: [...p.symbols], source: p.source })),
          ...(hasAlpacaKey
            ? EQUITY_PRESETS.map((p) => ({ id: p.id, label: p.label, assetClass: p.assetClass, symbols: [...p.symbols], source: 'alpaca' }))
            : []),
        ];
        const loader = makeScannerLoader(
          (sym) => client.klines(sym, app.feed.interval, barsToLoad),
          refRegistry,
          app.feed.interval,
          barsToLoad,
          hasAlpacaKey ? (sym) => alpaca.recentBars(sym, app.feed.interval, barsToLoad) : undefined,
        );
        return new OpportunityScanner(
          loader,
          presets,
          {
            entryZ: app.live.entryZ,
            exitZ: app.live.exitZ,
            feeBps: 5, // matches the registry fee gate + PaperVenue taker
            minEdgeMultiple: 1.5,
            barsPerDay: barsPerDayForInterval(app.feed.interval),
            sigmaWindowBars: 60,
            roundTripFactor: 2,
            barsToLoad,
            discovery: { minBars: 120, pValueCutoff: 0.1, minHalfLifeBars: 3, maxHalfLifeBars: 50 },
          },
        );
      },
    },
  ],
  controllers: [
    DemoController,
    DemoPageController,
    ResearchController,
    ExecController,
    UniverseController,
    LiveController,
    OpportunityController,
  ],
})
export class StatArbModule {}
