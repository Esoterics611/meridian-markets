import { Bar } from '../backtest/bar';
import { BacktestRunner } from '../backtest/backtest-runner';
import { PairsStrategy } from '../backtest/pairs-strategy';
import { ITradingVenue } from '../trading-venue.interface';

// Parameter sweep — Cartesian grid search over strategy params. Each cell
// runs an independent backtest; results are collected into a flat array
// suitable for a heatmap render.
//
// Parallelism: Promise.all → all backtests start concurrently. Node is
// single-threaded so this only buys us I/O concurrency (mock venue is
// synchronous, so it's effectively serial in practice). A future iteration
// could fan out to a worker pool — out of scope today.

export interface SweepAxis<T extends string = string> {
  /** Param name on the strategy config. */
  name: T;
  /** Values to try along this axis. */
  values: number[];
}

export interface SweepCellResult {
  /** Map of param name → value used for this cell. */
  params: Record<string, number>;
  totalPnlUnits: bigint;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalTrades: number;
}

export interface SweepConfig {
  barsA: Bar[];
  barsB: Bar[];
  axes: SweepAxis[];
  /** Fixed strategy params merged with each cell's swept values. */
  baseConfig: { beta: number; zLookback: number; notionalUnits: bigint; entryZ: number; exitZ: number };
  venueFactory: () => ITradingVenue;
}

export async function parameterSweep(cfg: SweepConfig): Promise<SweepCellResult[]> {
  if (cfg.axes.length === 0) throw new Error('parameterSweep: at least one axis required');
  for (const a of cfg.axes) {
    if (a.values.length === 0) throw new Error(`parameterSweep: axis '${a.name}' has no values`);
  }
  const cells = cartesian(cfg.axes);
  const runs = cells.map((params) => runCell(cfg, params));
  return Promise.all(runs);
}

function cartesian(axes: SweepAxis[]): Record<string, number>[] {
  return axes.reduce<Record<string, number>[]>(
    (acc, axis) =>
      acc.flatMap((row) => axis.values.map((v) => ({ ...row, [axis.name]: v }))),
    [{}],
  );
}

async function runCell(cfg: SweepConfig, params: Record<string, number>): Promise<SweepCellResult> {
  const merged = { ...cfg.baseConfig, ...params };
  const strategy = new PairsStrategy({
    beta: merged.beta,
    zLookback: merged.zLookback,
    entryZ: merged.entryZ,
    exitZ: merged.exitZ,
    notionalUnits: cfg.baseConfig.notionalUnits,
  });
  const r = await new BacktestRunner().run({
    barsA: cfg.barsA, barsB: cfg.barsB,
    strategy, venue: cfg.venueFactory(),
  });
  return {
    params,
    totalPnlUnits: r.metrics.totalPnlUnits,
    sharpeRatio: r.metrics.sharpeRatio,
    maxDrawdownPct: r.metrics.maxDrawdownPct,
    totalTrades: r.metrics.totalTrades,
  };
}

/** Rank cells by Sharpe descending. Caller decides which metric matters. */
export function rankBySharpe(cells: SweepCellResult[]): SweepCellResult[] {
  return cells.slice().sort((a, b) => b.sharpeRatio - a.sharpeRatio);
}
