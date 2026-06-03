import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { Bar } from '../stat-arb/backtest/bar';
import { BinancePublicClient, BINANCE_CLIENT } from '../stat-arb/feed/binance-public-client';
import { BinancePublicBarFeed } from '../stat-arb/feed/binance-public-bar-feed';
import { MockBarFeed } from '../stat-arb/feed/mock-bar-feed';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import {
  ReferenceSourceRegistry,
  buildReferenceSources,
} from '../market-data/reference/reference-bar-loader';
import { ReferenceBarFeed } from '../market-data/reference/reference-bar-feed';
import { MmController } from './mm.controller';
import { MmPortfolioTrader, MmBookSpec } from './live/mm-portfolio-trader';
import { MmBook } from './live/mm-book';
import { MmScreener } from './screen/mm-screener';
import { MM_MARKET_PRESETS } from './markets/mm-market-presets';
import { mmStrategyRegistry } from './registry/mm-strategy-registry';
import { CompositeRiskGate } from './risk/risk-gate';
import { barsPerDayForInterval } from '../stat-arb/discovery/net-edge-scorer';

// MarketMakingModule — the automated market-making desk. Self-contained: it
// provides its own Binance public client + per-book feed (the same swap-seam
// pattern StatArbModule uses), builds quoters from the MM registry, and exposes
// the MmController control plane. Imported once into AppModule; it never reaches
// into StatArbModule, so the two desks run side by side without coupling.
//
// Each launched book gets its OWN BinancePublicBarFeed instance (own per-symbol
// cursor) — exactly how LivePortfolioTrader isolates its stat-arb books — so two
// MM books never fight over a shared feed cursor.

const MM_BINANCE_CLIENT = Symbol('MM_BINANCE_CLIENT');

@Module({
  providers: [
    {
      provide: MM_BINANCE_CLIENT,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): BinancePublicClient => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new BinancePublicClient({ baseUrl: app.feed.binanceBaseUrl, quote: app.feed.quote });
      },
    },
    {
      provide: MmPortfolioTrader,
      inject: [ConfigService, MM_BINANCE_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient): MmPortfolioTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const mm = app.marketMaking;
        const onBinance = app.feed.source === 'binance';

        // Reference-source registry (Pyth / DefiLlama / Bit2C / GeckoTerminal),
        // so a DEX / decentralized book quotes on the SAME live loop as a Binance
        // book — selected per-book by `spec.source` (the MM twin of the stat-arb
        // per-source feed, S20). GeckoTerminal is the discovery frontier (S28).
        const refRegistry = new ReferenceSourceRegistry(
          buildReferenceSources({
            pythBaseUrl: app.feed.pythBaseUrl,
            defillamaBaseUrl: app.feed.defillamaBaseUrl,
            bit2cBaseUrl: app.feed.bit2cBaseUrl,
            geckoTerminalBaseUrl: app.feed.geckoTerminalBaseUrl,
            hyperliquidBaseUrl: app.feed.hyperliquidBaseUrl,
          }),
        );

        // Fee-aware spread floor: never quote below the maker round-trip
        // break-even. A maker rebate (makerFeeBps < 0) needs no floor; a maker
        // *cost* must be covered on both legs before the book can profit.
        const feeFloorBps = mm.makerFeeBps > 0 ? 2 * mm.makerFeeBps : 0;
        const effMinHalfSpreadBps = Math.max(mm.minHalfSpreadBps, feeFloorBps);
        const warmupBars = Math.max(mm.volWindowBars * 3, 90);

        const makeBook = (spec: MmBookSpec): MmBook => {
          const strategyId = spec.strategyId ?? mm.defaultStrategyId;
          const quoter = mmStrategyRegistry.build(strategyId, {
            quoteSizeUnits: mm.quoteSizeUnits,
            minHalfSpreadBps: effMinHalfSpreadBps,
            maxHalfSpreadBps: mm.maxHalfSpreadBps,
            maxInventoryLots: mm.maxInventoryLots,
            params: spec.params,
          });
          // A `source` book (e.g. DEX via GeckoTerminal) is fed by a
          // ReferenceBarFeed off that source; otherwise the Binance public feed
          // (or the mock feed when the engine isn't on Binance).
          const refSource = spec.source ? refRegistry.get(spec.source) : undefined;
          const feed: IBarFeed = refSource
            ? new ReferenceBarFeed(refSource, app.feed.interval)
            : onBinance
              ? new BinancePublicBarFeed(client, app.feed.interval)
              : new MockBarFeed();
          const warmupCloses = refSource
            ? async (s: string): Promise<number[]> =>
                (await refSource.klines(s, app.feed.interval, warmupBars).catch(() => [])).map((b) => b.close)
            : onBinance
              ? async (s: string): Promise<number[]> =>
                  (await client.klines(s, app.feed.interval, warmupBars)).map((b) => b.close)
              : undefined;
          const riskGate = new CompositeRiskGate({
            maxInventoryUnits: mm.quoteSizeUnits * BigInt(Math.ceil(mm.maxInventoryLots)),
            minNavRatio: 1 - mm.maxDrawdownPct / 100,
            vpinPauseThreshold: 2, // bar mode has no live VPIN; effectively off until the tick tape lands
            vpinPauseMs: 30_000,
            maxAdverseUnits: mm.capitalUnits, // generous; the tick-data path tightens this
            adversePauseMs: 30_000,
          });
          return new MmBook({
            symbol: spec.symbol,
            strategyId,
            quoter,
            quoteSizeUnits: mm.quoteSizeUnits,
            gamma: spec.params?.['gamma'] ?? mm.gamma,
            kappa: spec.params?.['kappa'] ?? mm.kappa,
            horizonBars: spec.params?.['horizonBars'] ?? mm.horizonBars,
            volWindowBars: mm.volWindowBars,
            volFloor: mm.volFloor,
            makerFeeBps: mm.makerFeeBps,
            capitalUnits: mm.capitalUnits,
            nextBar: (s) => feed.nextBar(s),
            warmupCloses,
            riskGate,
          });
        };

        return new MmPortfolioTrader(makeBook, mm.pollIntervalMs, mm.capitalUnits);
      },
    },
    // Spread-capture screener: ranks instruments by expected MM profit/day.
    {
      provide: MmScreener,
      inject: [ConfigService, MM_BINANCE_CLIENT],
      useFactory: (cfg: ConfigService, client: BinancePublicClient): MmScreener => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const mm = app.marketMaking;
        const barsToLoad = Math.max(mm.volWindowBars * 3, 120);
        const refRegistry = new ReferenceSourceRegistry(
          buildReferenceSources({
            pythBaseUrl: app.feed.pythBaseUrl,
            defillamaBaseUrl: app.feed.defillamaBaseUrl,
            bit2cBaseUrl: app.feed.bit2cBaseUrl,
            geckoTerminalBaseUrl: app.feed.geckoTerminalBaseUrl,
            hyperliquidBaseUrl: app.feed.hyperliquidBaseUrl,
          }),
        );
        const presets = MM_MARKET_PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          assetClass: p.assetClass,
          symbols: [...p.symbols],
          source: p.source,
        }));
        // Source-aware loader (mirrors makeScannerLoader): a reference-source
        // preset (e.g. DEX via GeckoTerminal) routes to the registry, Binance
        // presets to the public client. Errors collapse to [] in the screener.
        const loadBars = (sym: string, source?: string): Promise<Bar[]> =>
          source && source !== 'binance'
            ? refRegistry.bars(source, sym, app.feed.interval, barsToLoad)
            : client.klines(sym, app.feed.interval, barsToLoad);
        return new MmScreener(
          loadBars,
          presets,
          {
            quoteHalfSpreadBps: mm.minHalfSpreadBps,
            makerFeeBps: mm.makerFeeBps,
            barsPerDay: barsPerDayForInterval(app.feed.interval),
            volWindowBars: mm.volWindowBars,
            adverseCoef: 0.5,
            barsToLoad,
          },
        );
      },
    },
  ],
  controllers: [MmController],
})
export class MarketMakingModule {}
