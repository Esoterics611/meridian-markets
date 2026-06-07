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
import { IL2BookSource } from '../market-data/reference/reference-source.interface';
import { microPriceMicrosFromL2 } from './microstructure/l2-microprice';
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
import { MmNavRepository } from './persistence/mm-nav.repository';
import { MmNavCron } from './persistence/mm-nav.cron';
import { FundingRefreshCron } from './live/funding-refresh.cron';
import { MmScreener } from './screen/mm-screener';
import { DeskEventLog } from './events/desk-event-log';
import { ITelemetry, TELEMETRY } from '../telemetry/telemetry.interface';
import { NULL_TELEMETRY } from '../telemetry/null-telemetry';
import { M } from '../telemetry/metric-catalog';
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
      inject: [ConfigService, MM_BINANCE_CLIENT, DeskEventLog, { token: DbService, optional: true }, { token: TELEMETRY, optional: true }],
      useFactory: (cfg: ConfigService, client: BinancePublicClient, deskEvents: DeskEventLog, db?: DbService, telemetry?: ITelemetry): MmPortfolioTrader => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const mm = app.marketMaking;
        const onBinance = app.feed.source === 'binance';
        // Optional so the isolated mm.controller.spec (no TelemetryModule) resolves;
        // the full app injects the @Global TELEMETRY. No-op ⇒ zero behaviour change.
        const tele = telemetry ?? NULL_TELEMETRY;

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

        // Feed-poll telemetry: wrap nextBar so every poll counts (by source/result)
        // and times into a histogram — the data-quality signal (FR-3). No-op when
        // telemetry is off; the bar value is untouched, so behaviour is identical.
        const instrumentedNextBar = (srcLabel: string, feed: IBarFeed) => async (s: string): Promise<Bar | null> => {
          const startMs = Date.now();
          try {
            const bar = await feed.nextBar(s);
            tele.counter(M.feedPolls, { source: srcLabel, result: 'ok' });
            return bar;
          } catch (e) {
            tele.counter(M.feedPolls, { source: srcLabel, result: 'error' });
            throw e;
          } finally {
            tele.histogram(M.feedPollDuration, (Date.now() - startMs) / 1000, { source: srcLabel });
          }
        };

        // Shared feed/warmup routing: 'binance'/'mock' → native feed, a reference id
        // ('hyperliquid'/'geckoterminal'/…) → a ReferenceBarFeed. Used by both a fresh
        // launch and a restart-rehydration so a revived book reads the same feed.
        const resolveFeed = (srcId: string): { nextBar: (s: string) => Promise<Bar | null>; warmupCloses?: (s: string) => Promise<number[]> } => {
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
          return { nextBar: instrumentedNextBar(srcId, feed), warmupCloses };
        };

        // F1 live quote center: for an L2-capable venue (HL), a fast fair-value source
        // that fetches the depth snapshot and returns the micro-price; the quoter then
        // centers on it instead of the stale bar mid (the biggest adverse-selection
        // cut — FAIR_VALUE_AND_THESIS_DESIGN.md §Layer A). Other venues / depth=0 ⇒
        // undefined (the book keeps the mid; nothing regresses).
        const resolveReferenceMicros = (srcId: string): ((s: string) => Promise<bigint | null>) | undefined => {
          if (mm.microPriceDepth <= 0) return undefined;
          const refSource = srcId !== 'binance' && srcId !== 'mock' ? refRegistry.get(srcId) : undefined;
          const l2 = refSource as Partial<IL2BookSource> | undefined;
          if (!l2 || typeof l2.l2Snapshot !== 'function') return undefined;
          return async (s: string): Promise<bigint | null> => {
            try {
              return microPriceMicrosFromL2(await l2.l2Snapshot!(s), mm.microPriceDepth);
            } catch {
              return null;
            }
          };
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
          const { nextBar, warmupCloses } = resolveFeed(srcId);
          return new MmBook({
            symbol: spec.symbol,
            strategyId,
            source: srcId,
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
            nextBar,
            warmupCloses,
            referenceMicros: resolveReferenceMicros(srcId),
            riskGate: makeRiskGate(quoteSizeUnits),
            events: deskEvents,
          });
        };

        // Restart-safe rehydration: rebuild a book from its persisted record using
        // its EXACT resolved config (no notional re-probe), so it resumes identical.
        // The trader then restores the P&L state onto it.
        const rebuildBook = async (rec: MmBookRecord): Promise<MmBook> => {
          const srcId = rec.source ?? mm.defaultSource;
          const { nextBar, warmupCloses } = resolveFeed(srcId);
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
            source: srcId,
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
            nextBar,
            warmupCloses,
            referenceMicros: resolveReferenceMicros(srcId),
            riskGate: makeRiskGate(rec.quoteSizeUnits),
            events: deskEvents,
          });
        };

        // Persistence backend (restart-safe books): Postgres when MM_PERSIST is on
        // AND a DB connection is present, else a no-op Null store (no-DB runs + tests
        // behave exactly as before).
        const store: IMmStateStore = mm.persist && db ? new PostgresMmStateStore(new MmStateRepository(db)) : new NullMmStateStore();
        if (mm.persist && !db) new Logger('MarketMakingModule').warn('MM_PERSIST=true but no DbService — running in-memory (no restart-safe books)');

        return new MmPortfolioTrader(
          makeBook,
          mm.pollIntervalMs,
          mm.capitalUnits,
          { store, rebuildBook, flattenOnShutdown: mm.flattenOnShutdown },
          tele,
          deskEvents,
        );
      },
    },
    // Live business-event tape (fills enter/exit, verdict changes, lifecycle). A
    // single shared instance: injected into every MmBook + the trader (emit) and
    // the MmController (read at GET /api/market-making/events). In-memory + bounded
    // — the durable record is the append-only mm_nav table (Telemetry P3).
    DeskEventLog,
    // Durable NAV / equity-curve history (Telemetry P3). The repository is the
    // Postgres backend when MM_PERSIST is on AND a DB is present, else null so the
    // cron + endpoint no-op (no DB dependency on the live MM path — same posture as
    // the restart-safe store). DbService is optional (the controller unit test
    // builds this module in isolation, with no @Global DB).
    {
      provide: MmNavRepository,
      inject: [ConfigService, { token: DbService, optional: true }],
      useFactory: (cfg: ConfigService, db?: DbService): MmNavRepository | null => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.marketMaking.persist && db ? new MmNavRepository(db) : null;
      },
    },
    // The cron that appends the desk + per-book equity snapshot each interval. It
    // reads the same live snapshot() the telemetry collector does (DC-3) and is a
    // no-op when the repository above is null.
    {
      provide: MmNavCron,
      inject: [ConfigService, MmPortfolioTrader, MmNavRepository],
      useFactory: (cfg: ConfigService, trader: MmPortfolioTrader, repo: MmNavRepository | null): MmNavCron =>
        new MmNavCron(cfg, trader, repo),
    },
    // Perp funding-rate refresh: keeps each HL book's carry rate current over a
    // multi-hour run (funding drifts hourly; launch only sets it once). Its own HL
    // funding client (the launch path's is factory-scoped); non-perp books → null
    // (left unchanged), and an HL fetch error → null (keep the last good rate, don't
    // zero the carry). No-op when MM_FUNDING_REFRESH_MS=0 or in test.
    {
      provide: FundingRefreshCron,
      inject: [ConfigService, MmPortfolioTrader],
      useFactory: (cfg: ConfigService, trader: MmPortfolioTrader): FundingRefreshCron => {
        const app = cfg.getOrThrow<AppConfig>('app');
        const hlFunding = new HyperliquidFundingClient({ baseUrl: app.feed.hyperliquidBaseUrl });
        const rateFor = async (symbol: string, source: string | undefined): Promise<number | null> =>
          source === 'hyperliquid'
            ? hlFunding.currentFunding(symbol).then((f) => f.lastFundingRate).catch(() => null)
            : null;
        return new FundingRefreshCron(cfg, trader, rateFor);
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
  // Exported so TelemetryModule's collector + health controller can read the live
  // desk snapshot (DC-3). The @Global TELEMETRY token flows the other way (in).
  // DeskEventLog is exported so the UI's /desk/mm page can server-render the MM
  // Activity tape from the same in-memory event sink the fills emit into.
  exports: [MmPortfolioTrader, DeskEventLog],
})
export class MarketMakingModule {}
