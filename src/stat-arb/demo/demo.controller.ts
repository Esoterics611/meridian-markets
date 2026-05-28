import { Controller, Get, Post, Query } from '@nestjs/common';
import { DemoService, DemoSnapshot, DemoScenario, DEMO_SCENARIOS } from './demo.service';
import { BacktestResult, TradeRecord } from '../backtest/backtest-runner';
import { SlidingCointegrationResult } from '../signal/sliding-cointegration';
import { GateEvent as PairsGateEvent } from '../backtest/pairs-strategy';
import { GateEvent as RiskGateEvent } from '../risk/gate';

function parseScenario(s: string | undefined): DemoScenario {
  if (s !== undefined && (DEMO_SCENARIOS as readonly string[]).includes(s)) return s as DemoScenario;
  return 'calm';
}

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

interface ApiRefit {
  beta: number;
  pValue: number;
  halfLifeBars: number;
  fittedAtIndex: number;
}

interface ApiGateEvent {
  kind: string;
  barIndex: number;
  reason: string;
  zAtBlock: number;
}

interface ApiRiskEvent {
  kind: string;
  barIndex: number;
  reason: string;
  detail?: Record<string, number | string>;
}

interface ApiSnapshot {
  pair: { a: string; b: string };
  generatedAt: string;
  scenario: DemoScenario;
  currentZ: number;
  regime: 'LONG' | 'SHORT' | 'FLAT';
  openPnlUnits: string;
  metrics: ApiBacktestResult['metrics'];
  recentTrades: ApiTradeRecord[];
  allTrades: ApiTradeRecord[];
  equityCurve: string[];
  refits: ApiRefit[];
  gateEvents: ApiGateEvent[];
  riskEvents: ApiRiskEvent[];
  blockedEntries: number;
}

@Controller('api/stat-arb/demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('run')
  async run(@Query('scenario') scenario?: string): Promise<ApiBacktestResult> {
    const r = await this.demo.runFreshBacktest(parseScenario(scenario));
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
  async reset(@Query('scenario') scenario?: string): Promise<ApiBacktestResult> {
    this.demo.reset();
    const r = await this.demo.runFreshBacktest(parseScenario(scenario));
    return serialiseResult(r);
  }

  @Get('refits')
  async refits(): Promise<{ refits: ApiRefit[] }> {
    if (!this.demo.hasResult()) await this.demo.runFreshBacktest();
    return { refits: this.demo.refits().map(serialiseRefit) };
  }
}

function serialiseRefit(f: SlidingCointegrationResult): ApiRefit {
  return {
    beta: f.beta,
    // Half-life can be Infinity when the residual is non-mean-reverting; JSON
    // serialises Infinity as null, which the dashboard already handles.
    halfLifeBars: Number.isFinite(f.halfLifeBars) ? f.halfLifeBars : 0,
    pValue: f.pValue,
    fittedAtIndex: f.fittedAtIndex,
  };
}

function serialiseGateEvent(e: PairsGateEvent): ApiGateEvent {
  return { kind: e.kind, barIndex: e.barIndex, reason: e.reason, zAtBlock: e.zAtBlock };
}

function serialiseRiskEvent(e: RiskGateEvent): ApiRiskEvent {
  return { kind: e.kind, barIndex: e.barIndex, reason: e.reason, detail: e.detail };
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
    scenario: s.scenario,
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
    allTrades: s.allTrades.map(serialiseTrade),
    equityCurve: s.equityCurve.map((u) => u.toString()),
    refits: s.refits.map(serialiseRefit),
    gateEvents: s.gateEvents.map(serialiseGateEvent),
    riskEvents: s.riskEvents.map(serialiseRiskEvent),
    blockedEntries: s.blockedEntries,
  };
}
