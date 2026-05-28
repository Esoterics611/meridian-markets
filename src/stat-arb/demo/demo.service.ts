import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { BacktestRunner, BacktestResult, TradeRecord } from '../backtest/backtest-runner';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { generateSyntheticFeed } from '../backtest/synthetic-feed';
import { Bar } from '../backtest/bar';
import { ITradingVenue, TRADING_VENUE } from '../trading-venue.interface';
import { SlidingCointegrationResult } from '../signal/sliding-cointegration';
import { GateEvent as PairsGateEvent } from '../backtest/pairs-strategy';
import { GateEvent as RiskGateEvent } from '../risk/gate';
import { RiskEngine } from '../risk/risk-engine';
import { DrawdownGate } from '../risk/drawdown-gate';
import { VenueCapGate } from '../risk/venue-cap';
import { ExposureCapsGate } from '../risk/exposure-caps';

// In-memory holder for the most recent backtest. No DB persistence in Phase 3
// — see PHASE_3_DEMO_PROMPT.md §7 "Out of scope". The demo is a presentable
// simulation, not a production audit surface.
//
// Threading: NestJS singletons run on Node's single thread, so a Map and
// a `BacktestResult` field are race-free without locks.

export type DemoScenario = 'calm' | 'trending' | 'volatile' | 'decoupled';
export const DEMO_SCENARIOS: readonly DemoScenario[] = ['calm', 'trending', 'volatile', 'decoupled'];

export interface DemoSnapshot {
  pair: { a: string; b: string };
  generatedAt: Date;
  scenario: DemoScenario;
  currentZ: number;
  regime: 'LONG' | 'SHORT' | 'FLAT';
  openPnlUnits: bigint;
  metrics: BacktestResult['metrics'];
  recentTrades: TradeRecord[];
  allTrades: TradeRecord[];
  spreadSeries: BacktestResult['spreadSeries'];
  /** Cumulative realised PnL in USDC units at each bar index. equityCurve.length === spreadSeries.length. */
  equityCurve: bigint[];
  /** Sliding-β refit history. Empty when betaRefit is disabled. */
  refits: SlidingCointegrationResult[];
  /** Strategy gate events (P_VALUE_BLOCK from pairs-strategy). */
  gateEvents: PairsGateEvent[];
  /** Risk-engine gate events (drawdown / venue / exposure / correlation). */
  riskEvents: RiskGateEvent[];
  /** Count of OPEN orders blocked by the risk engine. */
  blockedEntries: number;
}

interface ScenarioConfig {
  barCount: number;
  spreadPeriodBars: number;
  spreadAmplitude: number;
  driftBoost: number; // extra log-spread drift applied per bar inside the feed
}

function scenarioConfig(s: DemoScenario, defaultBarCount: number): ScenarioConfig {
  switch (s) {
    case 'calm':       return { barCount: defaultBarCount,        spreadPeriodBars: 30, spreadAmplitude: 0.05, driftBoost: 0     };
    case 'trending':   return { barCount: defaultBarCount + 60,   spreadPeriodBars: 50, spreadAmplitude: 0.06, driftBoost: 0.0003 };
    case 'volatile':   return { barCount: defaultBarCount + 120,  spreadPeriodBars: 18, spreadAmplitude: 0.09, driftBoost: 0     };
    case 'decoupled':  return { barCount: defaultBarCount + 80,   spreadPeriodBars: 40, spreadAmplitude: 0.04, driftBoost: 0.0009 };
  }
}

@Injectable()
export class DemoService {
  private last: {
    result: BacktestResult;
    generatedAt: Date;
    scenario: DemoScenario;
    strategy: PairsStrategy;
    barsA: Bar[];
    barsB: Bar[];
  } | null = null;

  constructor(
    private readonly cfg: ConfigService,
    @Inject(TRADING_VENUE) private readonly venue: ITradingVenue,
  ) {}

  async runFreshBacktest(scenario: DemoScenario = 'calm'): Promise<BacktestResult> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const sc = scenarioConfig(scenario, app.statArb.demoBarCount);
    const { a, b } = generateSyntheticFeed({
      symbolA: app.statArb.demoPairA,
      symbolB: app.statArb.demoPairB,
      barCount: sc.barCount,
      spreadPeriodBars: sc.spreadPeriodBars,
      spreadAmplitude: sc.spreadAmplitude,
      basePriceB: 2000,
      aOverBRatio: 25,
      barIntervalMs: 60_000,
      startAt: new Date('2026-01-01T00:00:00Z'),
    });
    // For non-calm scenarios, perturb prices in-place so the spread takes on
    // the scenario character. Keeping this here (rather than in synthetic-feed)
    // means existing specs that pin the feed's deterministic output stay green.
    if (sc.driftBoost !== 0) {
      for (let i = 0; i < a.length; i++) {
        const extra = Math.exp(sc.driftBoost * i);
        a[i] = { ...a[i], open: a[i].open * extra, high: a[i].high * extra, low: a[i].low * extra, close: a[i].close * extra };
      }
    }
    const strategy = new PairsStrategy({
      beta: 1,
      zLookback: 20,
      entryZ: 1.2,
      exitZ: 0.3,
      notionalUnits: 1_000_000n,
      // Session 7: sliding-β with a permissive p-value gate. Volatile/decoupled
      // scenarios push p-values up, so the gate occasionally fires — visible
      // on the Risk-view Gate Event Log.
      betaRefit: { enabled: true, windowBars: 60, everyBars: 20, pValueGate: 0.10 },
    });
    // Demo risk engine — permissive caps so trades flow under calm/trending
    // and trip on volatile/decoupled. Numbers tuned against the synthetic feed.
    const riskEngine = new RiskEngine({
      drawdown: new DrawdownGate({ maxDrawdownPct: 5 }),
      venueCap: new VenueCapGate({ maxNotionalUnitsPerVenue: 50_000_000n }),
      exposure: new ExposureCapsGate({
        maxGrossUnits: 8_000_000n,
        maxNetUnits: 4_000_000n,
        maxPairUnits: 8_000_000n,
      }),
    });
    const result = await new BacktestRunner().run({
      barsA: a, barsB: b, strategy, venue: this.venue,
      riskEngine,
      riskOpts: { capitalUnits: 100_000_000n, pairId: `${app.statArb.demoPairA}/${app.statArb.demoPairB}` },
    });
    this.last = { result, generatedAt: new Date(), scenario, strategy, barsA: a, barsB: b };
    return result;
  }

  /** Synthetic OHLC bars for the configured symbol (a | b). Used by the
   *  /candles endpoint that powers the Lightweight Charts spread view.
   *  Returns an empty array before the first backtest runs. */
  bars(symbol: 'a' | 'b'): Bar[] {
    if (!this.last) return [];
    return symbol === 'a' ? this.last.barsA : this.last.barsB;
  }

  /** Pulls from the last cached run; throws if `runFreshBacktest` hasn't been called yet. */
  snapshot(): DemoSnapshot {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (!this.last) throw new Error('no backtest result yet — call /api/stat-arb/demo/run first');
    const r = this.last.result;
    const lastPoint = r.spreadSeries[r.spreadSeries.length - 1];
    const recent = r.trades.slice(-10);
    // Cumulative realised P&L per bar: step up at each trade's closeIndex by its pnlUnits.
    const equityCurve: bigint[] = new Array(r.spreadSeries.length).fill(0n);
    {
      // tradesByClose keyed by index for one pass over bars.
      const byClose = new Map<number, bigint>();
      for (const t of r.trades) byClose.set(t.closeIndex, (byClose.get(t.closeIndex) ?? 0n) + t.pnlUnits);
      let cum = 0n;
      for (let i = 0; i < equityCurve.length; i++) {
        const step = byClose.get(i);
        if (step !== undefined) cum += step;
        equityCurve[i] = cum;
      }
    }
    return {
      pair: { a: app.statArb.demoPairA, b: app.statArb.demoPairB },
      generatedAt: this.last.generatedAt,
      scenario: this.last.scenario,
      currentZ: lastPoint ? lastPoint.zScore : 0,
      regime: lastPoint ? lastPoint.position : 'FLAT',
      openPnlUnits: 0n, // demo backtest closes everything by EOR; no carryover.
      metrics: r.metrics,
      recentTrades: recent,
      allTrades: r.trades,
      spreadSeries: r.spreadSeries,
      equityCurve,
      refits: this.last.strategy.refitHistory(),
      gateEvents: this.last.strategy.gateLog(),
      riskEvents: r.gateEvents,
      blockedEntries: r.blockedEntries,
    };
  }

  /** Latest β-refit history. Empty array when betaRefit is disabled or before the first run. */
  refits(): SlidingCointegrationResult[] {
    return this.last ? this.last.strategy.refitHistory() : [];
  }

  reset(): void {
    this.last = null;
  }

  hasResult(): boolean {
    return this.last !== null;
  }
}
