import { Logger, Module } from '@nestjs/common';
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
import { quoteUnitsForNotional } from './live/notional-sizing';
import { venueFeeFor } from './backtest/venue-fees';
import { HyperliquidFundingClient } from '../market-data/funding/hyperliquid-funding-client';
import { DbService } from '@database/db.service';
import { MmStateRepository } from './persistence/mm-state.repository';
import { PostgresMmStateStore } from './persistence/postgres-mm-state-store';
import { NullMmStateStore } from './persistence/null-mm-state-store';
import { IMmStateStore, MmBookRecord } from './persistence/mm-state-store.interface';
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
      // DbService is optional: it's @Global in the full app, but the controller
      // unit test builds this module in isolation. Persistence needs it; without
      // it (or with MM_PERSIST off) the trader uses the no-op Null store.
      inject: [ConfigService, MM_BINANCE_CLIENT, { token: DbService, optional: true }],
      useFactory: (cfg: ConfigService, client: BinancePublicClient, db?: DbService): MmPortfolioTrader => {
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

        // Live perp funding for the inventory carry (5th P&L line — MM course §8.10).
        // Only a perp venue has funding; HL is the wired one. Spot/AMM books get 0.
        const hlFunding = new HyperliquidFundingClient({ baseUrl: app.feed.hyperliquidBaseUrl });
        const fundingRateFor = async (srcId: string | undefined, symbol: string): Promise<number> =>
          srcId === 'hyperliquid'
            ? hlFunding.currentFunding(symbol).then((f) => f.lastFundingRate).catch(() => 0)
            : 0;

        // Shared feed/warmup routing: 'binance'/'mock' → native feed, a reference id
        // ('hyperliquid'/'geckoterminal'/…) → a ReferenceBarFeed. Used by both a fresh
        // launch and a restart-rehydration so a revived book reads the same feed.
        const resolveFeed = (srcId: string): { feed: IBarFeed; warmupCloses?: (s: string) => Promise<number[]> } => {
          const refSource = srcId !== 'binance' && srcId !== 'mock' ? refRegistry.get(srcId) : undefined;
          const feed: IBarFeed = refSource
            ? new ReferenceBarFeed(refSource, app.feed.interval)
            : onBinance
              ? new BinancePublicBarFeed(client, app.feed.interval)
              : new MockBarFeed();
          const warmupCloses = refSource
            ? async (s: string): Promise<number[]> => (await refSource.klines(s, app.feed.interval, warmupBars).catch(() => [])).map((b) => b.close)
            : onBinance
              ? async (s: string): Promise<number[]> => (await client.klines(s, app.feed.interval, warmupBars)).map((b) => b.close)
              : undefined;
          return { feed, warmupCloses };
        };
        const makeRiskGate = (quoteSizeUnits: bigint): CompositeRiskGate =>
          new CompositeRiskGate({
            maxInventoryUnits: quoteSizeUnits * BigInt(Math.ceil(mm.maxInventoryLots)),
            minNavRatio: 1 - mm.maxDrawdownPct / 100,
            vpinPauseThreshold: 2, // bar mode has no live VPIN; effectively off until the tick tape lands
            vpinPauseMs: 30_000,
            maxAdverseUnits: mm.capitalUnits, // generous; the tick-data path tightens this
            adversePauseMs: 30_000,
          });

        const makeBook = async (spec: MmBookSpec): Promise<MmBook> => {
          const strategyId = spec.strategyId ?? mm.defaultStrategyId;
          const srcId = spec.source ?? mm.defaultSource;
          const refSource = srcId !== 'binance' && srcId !== 'mock' ? refRegistry.get(srcId) : undefined;

          // Notional sizing: when a $ quote is requested, probe the live price and
          // size quoteSizeUnits = notional ÷ price (notional-sizing.ts). Else fixed.
          let quoteSizeUnits = mm.quoteSizeUnits;
          if (spec.quoteNotionalUsd && spec.quoteNotionalUsd > 0) {
            const probe = refSource
              ? await refSource.klines(spec.symbol, app.feed.interval, 1).catch(() => [])
              : onBinance
                ? await client.klines(spec.symbol, app.feed.interval, 1).catch(() => [])
                : [];
            const price = probe[probe.length - 1]?.close ?? 0;
            quoteSizeUnits = quoteUnitsForNotional(spec.quoteNotionalUsd, price, mm.quoteSizeUnits);
          }

          const quoter = mmStrategyRegistry.build(strategyId, {
            quoteSizeUnits,
            minHalfSpreadBps: effMinHalfSpreadBps,
            maxHalfSpreadBps: mm.maxHalfSpreadBps,
            maxInventoryLots: mm.maxInventoryLots,
            params: spec.params,
          });
          const { feed, warmupCloses } = resolveFeed(srcId);
          return new MmBook({
            symbol: spec.symbol,
            strategyId,
            quoter,
            quoteSizeUnits,
            gamma: spec.params?.['gamma'] ?? mm.gamma,
            kappa: spec.params?.['kappa'] ?? mm.kappa,
            horizonBars: spec.params?.['horizonBars'] ?? mm.horizonBars,
            volWindowBars: mm.volWindowBars,
            volFloor: mm.volFloor,
            // Price the book at its OWN venue's real maker fee (venue-fees.ts): HL
            // −0.2bps rebate, Binance +1bps, DEX LP-fee. Honest per-book economics.
            makerFeeBps: venueFeeFor(srcId).makerBps,
            fundingRatePerHour: await fundingRateFor(srcId, spec.symbol),
            capitalUnits: mm.capitalUnits,
            nextBar: (s) => feed.nextBar(s),
            warmupCloses,
            riskGate: makeRiskGate(quoteSizeUnits),
          });
        };

        // Restart-safe rehydration: rebuild a book from its persisted record using
        // its EXACT resolved config (no notional re-probe), so it resumes identical.
        // The trader then restores the P&L state onto it.
        const rebuildBook = async (rec: MmBookRecord): Promise<MmBook> => {
          const { feed, warmupCloses } = resolveFeed(rec.source ?? mm.defaultSource);
          const quoter = mmStrategyRegistry.build(rec.strategyId, {
            quoteSizeUnits: rec.quoteSizeUnits,
            minHalfSpreadBps: effMinHalfSpreadBps,
            maxHalfSpreadBps: mm.maxHalfSpreadBps,
            maxInventoryLots: mm.maxInventoryLots,
            params: rec.params ?? undefined,
          });
          return new MmBook({
            symbol: rec.symbol,
            strategyId: rec.strategyId,
            quoter,
            quoteSizeUnits: rec.quoteSizeUnits,
            gamma: rec.gamma,
            kappa: rec.kappa,
            horizonBars: rec.horizonBars,
            volWindowBars: rec.volWindowBars,
            volFloor: rec.volFloor,
            makerFeeBps: rec.makerFeeBps,
            fundingRatePerHour: rec.fundingRatePerHour,
            capitalUnits: rec.capitalUnits,
            nextBar: (s) => feed.nextBar(s),
            warmupCloses,
            riskGate: makeRiskGate(rec.quoteSizeUnits),
          });
        };

        // Persistence backend (restart-safe books): Postgres when MM_PERSIST is on
        // AND a DB connection is present, else a no-op Null store (no-DB runs + tests
        // behave exactly as before).
        const store: IMmStateStore = mm.persist && db ? new PostgresMmStateStore(new MmStateRepository(db)) : new NullMmStateStore();
        if (mm.persist && !db) new Logger('MarketMakingModule').warn('MM_PERSIST=true but no DbService — running in-memory (no restart-safe books)');

        return new MmPortfolioTrader(makeBook, mm.pollIntervalMs, mm.capitalUnits, {
          store,
          rebuildBook,
          flattenOnShutdown: mm.flattenOnShutdown,
        });
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
