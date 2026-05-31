import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { BinancePublicClient, BINANCE_CLIENT } from '../stat-arb/feed/binance-public-client';
import { BinancePublicBarFeed } from '../stat-arb/feed/binance-public-bar-feed';
import { MockBarFeed } from '../stat-arb/feed/mock-bar-feed';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import { MmController } from './mm.controller';
import { MmPortfolioTrader, MmBookSpec } from './live/mm-portfolio-trader';
import { MmBook } from './live/mm-book';
import { mmStrategyRegistry } from './registry/mm-strategy-registry';
import { CompositeRiskGate } from './risk/risk-gate';

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

        // Fee-aware spread floor: never quote below the maker round-trip
        // break-even. A maker rebate (makerFeeBps < 0) needs no floor; a maker
        // *cost* must be covered on both legs before the book can profit.
        const feeFloorBps = mm.makerFeeBps > 0 ? 2 * mm.makerFeeBps : 0;
        const effMinHalfSpreadBps = Math.max(mm.minHalfSpreadBps, feeFloorBps);

        const makeBook = (spec: MmBookSpec): MmBook => {
          const strategyId = spec.strategyId ?? mm.defaultStrategyId;
          const quoter = mmStrategyRegistry.build(strategyId, {
            quoteSizeUnits: mm.quoteSizeUnits,
            minHalfSpreadBps: effMinHalfSpreadBps,
            maxHalfSpreadBps: mm.maxHalfSpreadBps,
            maxInventoryLots: mm.maxInventoryLots,
            params: spec.params,
          });
          const feed: IBarFeed = onBinance ? new BinancePublicBarFeed(client, app.feed.interval) : new MockBarFeed();
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
            warmupCloses: onBinance
              ? async (s) => (await client.klines(s, app.feed.interval, Math.max(mm.volWindowBars * 3, 90))).map((b) => b.close)
              : undefined,
            riskGate,
          });
        };

        return new MmPortfolioTrader(makeBook, mm.pollIntervalMs, mm.capitalUnits);
      },
    },
  ],
  controllers: [MmController],
})
export class MarketMakingModule {}
