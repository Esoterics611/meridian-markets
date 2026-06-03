import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { ITradingVenue, TRADING_VENUE } from '../trading-venue.interface';
import { walkForward, WalkForwardReport } from './walk-forward';
import { parameterSweep, SweepCellResult, rankBySharpe } from './parameter-sweep';
import { monteCarlo } from './monte-carlo';
import { BacktestRunner } from '../backtest/backtest-runner';

// /api/stat-arb/research/* — three endpoints feeding the dashboard's
// Research desk. They run against the same synthetic feed as the Trader
// demo so the numbers are comparable — i.e. they show the SHAPE of the
// robustness machinery, not numbers for a live pair.
//
// For walk-forward on REAL Binance history with a true train/test split
// (β fit on train, evaluated OOS on test, net of slippage), use
// POST /api/market-data/walk-forward — it reuses the same walkForward()
// harness over real stored bars (see MarketDataController).

// Desk lot for the (synthetic) research demos. The desk trades BIG — single-
// dollar toy moves are useless to read — so even the shape-demos size at a real
// $100k/leg, not $1. (The REAL walk-forward takes the live desk lot from the UI.)
const RESEARCH_NOTIONAL_UNITS = 100_000_000_000n; // $100k/leg

@Controller('api/stat-arb/research')
export class ResearchController {
  constructor(
    private readonly cfg: ConfigService,
    @Inject(TRADING_VENUE) private readonly venue: ITradingVenue,
  ) {}

  @Get('walk-forward')
  async walkForwardEndpoint(
    @Query('train') train?: string,
    @Query('test') test?: string,
    @Query('bars') bars?: string,
  ): Promise<{
    avgTestSharpe: number;
    positiveWindowShare: number;
    windows: Array<{
      windowIndex: number; trainStart: number; testStart: number; testEnd: number;
      train: { sharpeRatio: number; maxDrawdownPct: number; totalTrades: number; totalPnlUnits: string };
      test:  { sharpeRatio: number; maxDrawdownPct: number; totalTrades: number; totalPnlUnits: string; calmar: number };
    }>;
  }> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const trainBars = parseIntOr(train, 80);
    const testBars  = parseIntOr(test, 40);
    const barCount  = parseIntOr(bars, 360);
    const { a, b } = generateSyntheticFeed({
      symbolA: app.statArb.demoPairA, symbolB: app.statArb.demoPairB,
      barCount, spreadPeriodBars: 30, spreadAmplitude: 0.05,
      basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
      startAt: new Date('2026-01-01T00:00:00Z'),
    });
    const r = await walkForward({
      barsA: a, barsB: b, trainBars, testBars,
      strategyFactory: () => new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: RESEARCH_NOTIONAL_UNITS }),
      venueFactory: () => this.venue,
    });
    return serialiseWalkForward(r);
  }

  @Get('sweep')
  async sweepEndpoint(): Promise<{ cells: Array<{ params: Record<string, number>; sharpeRatio: number; totalPnlUnits: string; maxDrawdownPct: number; totalTrades: number }> }> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const { a, b } = generateSyntheticFeed({
      symbolA: app.statArb.demoPairA, symbolB: app.statArb.demoPairB,
      barCount: 200, spreadPeriodBars: 30, spreadAmplitude: 0.05,
      basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
      startAt: new Date('2026-01-01T00:00:00Z'),
    });
    const cells = await parameterSweep({
      barsA: a, barsB: b,
      axes: [
        { name: 'entryZ', values: [1.0, 1.2, 1.5, 2.0] },
        { name: 'exitZ',  values: [0.0, 0.3, 0.5] },
      ],
      baseConfig: { beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: RESEARCH_NOTIONAL_UNITS },
      venueFactory: () => this.venue,
    });
    return { cells: rankBySharpe(cells).map(serialiseCell) };
  }

  @Get('monte-carlo')
  async monteCarloEndpoint(
    @Query('reps') reps?: string,
    @Query('seed') seed?: string,
  ): Promise<{
    replications: number;
    p05: number[]; p50: number[]; p95: number[];
    summary: { meanFinalPnl: number; medianFinalPnl: number; p05FinalPnl: number; p95FinalPnl: number; probPositive: number };
  }> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const replications = parseIntOr(reps, 200);
    const seedNum = parseIntOr(seed, 42);
    const { a, b } = generateSyntheticFeed({
      symbolA: app.statArb.demoPairA, symbolB: app.statArb.demoPairB,
      barCount: app.statArb.demoBarCount, spreadPeriodBars: 30, spreadAmplitude: 0.05,
      basePriceB: 2000, aOverBRatio: 25, barIntervalMs: 60_000,
      startAt: new Date('2026-01-01T00:00:00Z'),
    });
    const baseResult = await new BacktestRunner().run({
      barsA: a, barsB: b,
      strategy: new PairsStrategy({ beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: RESEARCH_NOTIONAL_UNITS }),
      venue: this.venue,
    });
    return monteCarlo({ trades: baseResult.trades, replications, seed: seedNum });
  }
}

function parseIntOr(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function serialiseWalkForward(r: WalkForwardReport) {
  return {
    avgTestSharpe: r.avgTestSharpe,
    positiveWindowShare: r.positiveWindowShare,
    windows: r.windows.map((w) => ({
      windowIndex: w.windowIndex,
      trainStart: w.trainStart, testStart: w.testStart, testEnd: w.testEnd,
      train: {
        sharpeRatio: w.train.sharpeRatio,
        maxDrawdownPct: w.train.maxDrawdownPct,
        totalTrades: w.train.totalTrades,
        totalPnlUnits: w.train.totalPnlUnits.toString(),
      },
      test: {
        sharpeRatio: w.test.sharpeRatio,
        maxDrawdownPct: w.test.maxDrawdownPct,
        totalTrades: w.test.totalTrades,
        totalPnlUnits: w.test.totalPnlUnits.toString(),
        calmar: w.test.calmar,
      },
    })),
  };
}

function serialiseCell(c: SweepCellResult) {
  return {
    params: c.params,
    sharpeRatio: c.sharpeRatio,
    totalPnlUnits: c.totalPnlUnits.toString(),
    maxDrawdownPct: c.maxDrawdownPct,
    totalTrades: c.totalTrades,
  };
}
