import { Bar } from '../backtest/bar';
import { BacktestRunner, BacktestResult } from '../backtest/backtest-runner';
import { PairsStrategy, PairsStrategyConfig } from '../backtest/pairs-strategy';
import { ITradingVenue } from '../trading-venue.interface';
import { summarize } from '../backtest/pnl-attribution';

// Walk-forward — slides a (train, test) split across the timeline so the
// strategy's metrics are evaluated only on out-of-sample data. This is the
// canonical safeguard against overfitting a single backtest.
//
// Layout (W = trainBars, H = testBars):
//   window 0: train [0,    W),         test [W,     W+H)
//   window 1: train [W,    W+H),       test [W+H,   W+2H)
//   ... etc, step by H ...
// The train window is informational only here (cointegration is re-fit by
// the strategy via betaRefit). We still emit train.metrics for the user to
// inspect train-vs-test degradation, which is the actual research signal.

export interface WalkForwardWindowResult {
  windowIndex: number;
  trainStart: number;
  testStart: number;
  testEnd: number;
  train: { totalPnlUnits: bigint; sharpeRatio: number; maxDrawdownPct: number; totalTrades: number };
  test:  { totalPnlUnits: bigint; sharpeRatio: number; maxDrawdownPct: number; totalTrades: number; calmar: number };
}

export interface WalkForwardReport {
  windows: WalkForwardWindowResult[];
  /** Average test-window Sharpe — the headline number traders look at. */
  avgTestSharpe: number;
  /** % of windows where the test Sharpe was positive. */
  positiveWindowShare: number;
}

export interface WalkForwardConfig {
  barsA: Bar[];
  barsB: Bar[];
  trainBars: number;
  testBars: number;
  /** Strategy factory — called fresh per window so state never bleeds. */
  strategyFactory: () => PairsStrategy;
  venueFactory: () => ITradingVenue;
}

export async function walkForward(cfg: WalkForwardConfig): Promise<WalkForwardReport> {
  if (cfg.barsA.length !== cfg.barsB.length) {
    throw new Error('walkForward: barsA and barsB must have same length');
  }
  if (cfg.trainBars < 1 || cfg.testBars < 1) {
    throw new Error('walkForward: trainBars and testBars must both be >= 1');
  }
  const N = cfg.barsA.length;
  const windows: WalkForwardWindowResult[] = [];
  let idx = 0;
  for (let trainStart = 0; trainStart + cfg.trainBars + cfg.testBars <= N; trainStart += cfg.testBars) {
    const testStart = trainStart + cfg.trainBars;
    const testEnd = testStart + cfg.testBars;
    const trainResult = await runSlice(cfg, trainStart, testStart);
    const testResult  = await runSlice(cfg, testStart, testEnd);
    const calmar = testResult.metrics.maxDrawdownPct > 0
      ? (Number(testResult.metrics.totalPnlUnits) / 1_000_000) / testResult.metrics.maxDrawdownPct
      : 0;
    windows.push({
      windowIndex: idx++,
      trainStart, testStart, testEnd,
      train: {
        totalPnlUnits: trainResult.metrics.totalPnlUnits,
        sharpeRatio: trainResult.metrics.sharpeRatio,
        maxDrawdownPct: trainResult.metrics.maxDrawdownPct,
        totalTrades: trainResult.metrics.totalTrades,
      },
      test: {
        totalPnlUnits: testResult.metrics.totalPnlUnits,
        sharpeRatio: testResult.metrics.sharpeRatio,
        maxDrawdownPct: testResult.metrics.maxDrawdownPct,
        totalTrades: testResult.metrics.totalTrades,
        calmar,
      },
    });
  }
  const avgTestSharpe = windows.length
    ? windows.reduce((s, w) => s + w.test.sharpeRatio, 0) / windows.length
    : 0;
  const positiveWindowShare = windows.length
    ? windows.filter((w) => w.test.sharpeRatio > 0).length / windows.length
    : 0;
  return { windows, avgTestSharpe, positiveWindowShare };
}

async function runSlice(cfg: WalkForwardConfig, start: number, end: number): Promise<BacktestResult> {
  return new BacktestRunner().run({
    barsA: cfg.barsA.slice(start, end),
    barsB: cfg.barsB.slice(start, end),
    strategy: cfg.strategyFactory(),
    venue: cfg.venueFactory(),
  });
}

/** Convenience: re-summarise trades from a partial backtest. Used by callers post-hoc. */
export { summarize };
