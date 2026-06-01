import { Bar } from '../backtest/bar';
import { BacktestRunner, BacktestResult } from '../backtest/backtest-runner';
import { ManagedStrategy } from '../backtest/strategy.interface';
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
// Each window's `strategyFactory` is handed the TRAIN slice so the caller can
// fit parameters (e.g. the cointegration β) on train only and apply them OOS on
// test — a true walk-forward with no peeking forward. The train run reuses the
// same train-fitted strategy, so train.metrics are in-sample by construction;
// the train-vs-test gap (degradation) is the actual research signal.
//
// `venueFactory` is handed the slice being run because a HistoricalReplayVenue
// maps each fill's bar index (encoded in the idempotencyKey) to a price WITHIN
// the slice — a single venue over the full series would mis-price every window
// past the first. A mock venue can ignore both args.

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

/** The train slice for a window — handed to the strategy factory so params (β) are fit OOS-safely. */
export interface WalkForwardTrainContext {
  trainBarsA: Bar[];
  trainBarsB: Bar[];
}

export interface WalkForwardConfig {
  barsA: Bar[];
  barsB: Bar[];
  trainBars: number;
  testBars: number;
  /**
   * Strategy factory — called fresh per slice so state never bleeds, and handed
   * the window's TRAIN slice so the caller can fit β (or other params) on train
   * and apply them OOS on test. A caller with frozen params can ignore the arg.
   */
  strategyFactory: (ctx: WalkForwardTrainContext) => ManagedStrategy;
  /** Venue factory — handed the exact slice being run (needed by replay venues). */
  venueFactory: (barsA: Bar[], barsB: Bar[]) => ITradingVenue;
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
    // Fit params on the train slice only; reuse that fit for both the in-sample
    // train run and the out-of-sample test run.
    const trainCtx: WalkForwardTrainContext = {
      trainBarsA: cfg.barsA.slice(trainStart, testStart),
      trainBarsB: cfg.barsB.slice(trainStart, testStart),
    };
    const trainResult = await runSlice(cfg, trainStart, testStart, trainCtx);
    const testResult  = await runSlice(cfg, testStart, testEnd, trainCtx);
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

async function runSlice(
  cfg: WalkForwardConfig,
  start: number,
  end: number,
  trainCtx: WalkForwardTrainContext,
): Promise<BacktestResult> {
  const barsA = cfg.barsA.slice(start, end);
  const barsB = cfg.barsB.slice(start, end);
  return new BacktestRunner().run({
    barsA,
    barsB,
    strategy: cfg.strategyFactory(trainCtx),
    venue: cfg.venueFactory(barsA, barsB),
  });
}

/** Convenience: re-summarise trades from a partial backtest. Used by callers post-hoc. */
export { summarize };
