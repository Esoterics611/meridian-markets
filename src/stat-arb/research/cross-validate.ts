import { Bar } from '../backtest/bar';
import { BacktestRunner } from '../backtest/backtest-runner';
import { ManagedStrategy } from '../backtest/strategy.interface';
import { ITradingVenue } from '../trading-venue.interface';
import { purgedKFoldSplits } from './purged-kfold';

// Purged k-fold cross-validation RUNNER — the counterpart to walkForward() for
// the purged-kfold scheme. Each fold's contiguous test block is backtested with
// a strategy fit on the (purged + embargoed) train indices, so:
//   • β is fit without the bars adjacent to the test fold (no leakage), and
//   • every fold contributes OOS trades, pooled for deflated-Sharpe / PSR.
// The contiguous test slice is what BacktestRunner + a replay venue can price;
// train indices are generally non-contiguous (both sides of the fold).

export interface PurgedKFoldFold {
  foldIndex: number;
  trainSize: number;
  testStart: number;
  testEnd: number;
  test: { sharpeRatio: number; totalPnlUnits: bigint; totalTrades: number; maxDrawdownPct: number };
  /** Per-trade OOS P&L (USDC units) for this fold. */
  testTradePnlUnits: bigint[];
}

export interface PurgedKFoldReport {
  folds: PurgedKFoldFold[];
  avgTestSharpe: number;
  positiveFoldShare: number;
  /** All OOS trade P&Ls pooled across folds — feed to deflated-Sharpe / PSR. */
  oosTradePnlUnits: bigint[];
}

export interface PurgedKFoldConfig {
  barsA: Bar[];
  barsB: Bar[];
  folds: number;
  embargoFrac?: number;
  /** Strategy fit on the (non-contiguous) train bars, applied on the contiguous test slice. */
  strategyFactory: (trainBarsA: Bar[], trainBarsB: Bar[]) => ManagedStrategy;
  /** Venue over the contiguous test slice (a replay venue prices it by index). */
  venueFactory: (testBarsA: Bar[], testBarsB: Bar[]) => ITradingVenue;
}

export async function purgedKFoldCv(cfg: PurgedKFoldConfig): Promise<PurgedKFoldReport> {
  if (cfg.barsA.length !== cfg.barsB.length) {
    throw new Error('purgedKFoldCv: barsA and barsB must have same length');
  }
  const splits = purgedKFoldSplits(cfg.barsA.length, cfg.folds, cfg.embargoFrac);
  const folds: PurgedKFoldFold[] = [];
  const oos: bigint[] = [];
  for (const s of splits) {
    const trainA = s.trainIdx.map((i) => cfg.barsA[i]);
    const trainB = s.trainIdx.map((i) => cfg.barsB[i]);
    const testA = cfg.barsA.slice(s.testStart, s.testEnd);
    const testB = cfg.barsB.slice(s.testStart, s.testEnd);
    const res = await new BacktestRunner().run({
      barsA: testA,
      barsB: testB,
      strategy: cfg.strategyFactory(trainA, trainB),
      venue: cfg.venueFactory(testA, testB),
    });
    const pnls = res.trades.map((t) => t.pnlUnits);
    for (const p of pnls) oos.push(p);
    folds.push({
      foldIndex: s.foldIndex,
      trainSize: s.trainIdx.length,
      testStart: s.testStart,
      testEnd: s.testEnd,
      test: {
        sharpeRatio: res.metrics.sharpeRatio,
        totalPnlUnits: res.metrics.totalPnlUnits,
        totalTrades: res.metrics.totalTrades,
        maxDrawdownPct: res.metrics.maxDrawdownPct,
      },
      testTradePnlUnits: pnls,
    });
  }
  const avgTestSharpe = folds.length ? folds.reduce((a, f) => a + f.test.sharpeRatio, 0) / folds.length : 0;
  const positiveFoldShare = folds.length ? folds.filter((f) => f.test.totalPnlUnits > 0n).length / folds.length : 0;
  return { folds, avgTestSharpe, positiveFoldShare, oosTradePnlUnits: oos };
}
