import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { BacktestRunner, BacktestResult, TradeRecord } from '../backtest/backtest-runner';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { ITradingVenue, TRADING_VENUE } from '../trading-venue.interface';

// In-memory holder for the most recent backtest. No DB persistence in Phase 3
// — see PHASE_3_DEMO_PROMPT.md §7 "Out of scope". The demo is a presentable
// simulation, not a production audit surface.
//
// Threading: NestJS singletons run on Node's single thread, so a Map and
// a `BacktestResult` field are race-free without locks.

export interface DemoSnapshot {
  pair: { a: string; b: string };
  generatedAt: Date;
  currentZ: number;
  regime: 'LONG' | 'SHORT' | 'FLAT';
  openPnlUnits: bigint;
  metrics: BacktestResult['metrics'];
  recentTrades: TradeRecord[];
  spreadSeries: BacktestResult['spreadSeries'];
}

@Injectable()
export class DemoService {
  private last: { result: BacktestResult; generatedAt: Date } | null = null;

  constructor(
    private readonly cfg: ConfigService,
    @Inject(TRADING_VENUE) private readonly venue: ITradingVenue,
  ) {}

  async runFreshBacktest(): Promise<BacktestResult> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const { a, b } = generateSyntheticFeed({
      symbolA: app.statArb.demoPairA,
      symbolB: app.statArb.demoPairB,
      barCount: app.statArb.demoBarCount,
      spreadPeriodBars: 30,
      spreadAmplitude: 0.05,
      basePriceB: 2000,
      aOverBRatio: 25,
      barIntervalMs: 60_000,
      startAt: new Date('2026-01-01T00:00:00Z'),
    });
    const strategy = new PairsStrategy({
      beta: 1,
      zLookback: 20,
      entryZ: 1.2,
      exitZ: 0.3,
      notionalUnits: 1_000_000n,
    });
    const result = await new BacktestRunner().run({ barsA: a, barsB: b, strategy, venue: this.venue });
    this.last = { result, generatedAt: new Date() };
    return result;
  }

  /** Pulls from the last cached run; throws if `runFreshBacktest` hasn't been called yet. */
  snapshot(): DemoSnapshot {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (!this.last) throw new Error('no backtest result yet — call /api/stat-arb/demo/run first');
    const r = this.last.result;
    const lastPoint = r.spreadSeries[r.spreadSeries.length - 1];
    const recent = r.trades.slice(-10);
    return {
      pair: { a: app.statArb.demoPairA, b: app.statArb.demoPairB },
      generatedAt: this.last.generatedAt,
      currentZ: lastPoint ? lastPoint.zScore : 0,
      regime: lastPoint ? lastPoint.position : 'FLAT',
      openPnlUnits: 0n, // demo backtest closes everything by EOR; no carryover.
      metrics: r.metrics,
      recentTrades: recent,
      spreadSeries: r.spreadSeries,
    };
  }

  reset(): void {
    this.last = null;
  }

  hasResult(): boolean {
    return this.last !== null;
  }
}
