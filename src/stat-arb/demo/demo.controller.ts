import { Controller, Get, Post } from '@nestjs/common';
import { DemoService, DemoSnapshot } from './demo.service';
import { BacktestResult, TradeRecord } from '../backtest/backtest-runner';

// All bigints are serialised as strings — JSON cannot represent them and
// the dashboard receives them as USDC-unit integers. Same convention as
// the treasury controller's amount fields.

interface ApiTradeRecord {
  openIndex: number;
  closeIndex: number;
  side: 'LONG' | 'SHORT';
  entryZ: number;
  exitZ: number;
  pnlUnits: string;
  holdBars: number;
}

interface ApiBacktestResult {
  trades: ApiTradeRecord[];
  metrics: {
    totalPnlUnits: string;
    sharpeRatio: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
  };
  spreadSeries: { timestamp: string; zScore: number; position: 'LONG' | 'SHORT' | 'FLAT' }[];
}

interface ApiSnapshot {
  pair: { a: string; b: string };
  generatedAt: string;
  currentZ: number;
  regime: 'LONG' | 'SHORT' | 'FLAT';
  openPnlUnits: string;
  metrics: ApiBacktestResult['metrics'];
  recentTrades: ApiTradeRecord[];
}

@Controller('api/stat-arb/demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('run')
  async run(): Promise<ApiBacktestResult> {
    const r = await this.demo.runFreshBacktest();
    return serialiseResult(r);
  }

  @Get('status')
  async status(): Promise<ApiSnapshot> {
    if (!this.demo.hasResult()) {
      // Lazy first-run so the dashboard never sees a 500 before "Run Demo".
      await this.demo.runFreshBacktest();
    }
    const s = this.demo.snapshot();
    return serialiseSnapshot(s);
  }

  @Get('history')
  async history(): Promise<{ series: ApiBacktestResult['spreadSeries'] }> {
    if (!this.demo.hasResult()) await this.demo.runFreshBacktest();
    const s = this.demo.snapshot();
    return {
      series: s.spreadSeries.map((p) => ({
        timestamp: p.timestamp.toISOString(),
        zScore: p.zScore,
        position: p.position,
      })),
    };
  }

  @Post('reset')
  async reset(): Promise<ApiBacktestResult> {
    this.demo.reset();
    const r = await this.demo.runFreshBacktest();
    return serialiseResult(r);
  }
}

function serialiseTrade(t: TradeRecord): ApiTradeRecord {
  return {
    openIndex: t.openIndex,
    closeIndex: t.closeIndex,
    side: t.side,
    entryZ: t.entryZ,
    exitZ: t.exitZ,
    pnlUnits: t.pnlUnits.toString(),
    holdBars: t.holdBars,
  };
}

function serialiseResult(r: BacktestResult): ApiBacktestResult {
  return {
    trades: r.trades.map(serialiseTrade),
    metrics: {
      totalPnlUnits: r.metrics.totalPnlUnits.toString(),
      sharpeRatio: r.metrics.sharpeRatio,
      maxDrawdownPct: r.metrics.maxDrawdownPct,
      winRate: r.metrics.winRate,
      totalTrades: r.metrics.totalTrades,
    },
    spreadSeries: r.spreadSeries.map((p) => ({
      timestamp: p.timestamp.toISOString(),
      zScore: p.zScore,
      position: p.position,
    })),
  };
}

function serialiseSnapshot(s: DemoSnapshot): ApiSnapshot {
  return {
    pair: s.pair,
    generatedAt: s.generatedAt.toISOString(),
    currentZ: s.currentZ,
    regime: s.regime,
    openPnlUnits: s.openPnlUnits.toString(),
    metrics: {
      totalPnlUnits: s.metrics.totalPnlUnits.toString(),
      sharpeRatio: s.metrics.sharpeRatio,
      maxDrawdownPct: s.metrics.maxDrawdownPct,
      winRate: s.metrics.winRate,
      totalTrades: s.metrics.totalTrades,
    },
    recentTrades: s.recentTrades.map(serialiseTrade),
  };
}
