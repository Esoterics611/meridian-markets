import { TradeRecord } from '../backtest/backtest-runner';

// Monte Carlo bootstrap — given the per-trade P&L series from a single
// backtest, resample (with replacement) M synthetic histories and derive a
// distribution of cumulative P&L. The output is per-trade-step percentile
// curves so the dashboard can render a fan chart.

export interface MonteCarloConfig {
  trades: TradeRecord[];
  /** Number of bootstrap replications. 1000+ for production; 200 for the demo. */
  replications: number;
  /** Deterministic seed so the demo is reproducible. */
  seed?: number;
}

export interface MonteCarloReport {
  /** Number of bootstrap replications run. */
  replications: number;
  /** Per-step percentile curves (cumulative P&L in USDC units, scaled to number). */
  p05: number[];
  p50: number[];
  p95: number[];
  /** Final-P&L distribution summary. */
  summary: {
    meanFinalPnl: number;
    medianFinalPnl: number;
    p05FinalPnl: number;
    p95FinalPnl: number;
    probPositive: number;
  };
}

// Mulberry32 RNG. Same seedable PRNG used by the cointegration tests so the
// MC output is byte-identical across runs for a given seed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarlo(cfg: MonteCarloConfig): MonteCarloReport {
  if (cfg.replications < 1) throw new Error('monteCarlo: replications must be >= 1');
  if (cfg.trades.length === 0) {
    const empty = { replications: cfg.replications, p05: [], p50: [], p95: [],
      summary: { meanFinalPnl: 0, medianFinalPnl: 0, p05FinalPnl: 0, p95FinalPnl: 0, probPositive: 0 } };
    return empty;
  }
  const N = cfg.trades.length;
  const pnls = cfg.trades.map((t) => Number(t.pnlUnits));
  const rand = rng(cfg.seed ?? 42);

  // For each replication, sample N trades with replacement and accumulate.
  const cumByRep: number[][] = new Array(cfg.replications);
  for (let r = 0; r < cfg.replications; r++) {
    const cum = new Array<number>(N);
    let running = 0;
    for (let i = 0; i < N; i++) {
      running += pnls[Math.floor(rand() * pnls.length)];
      cum[i] = running;
    }
    cumByRep[r] = cum;
  }

  // Percentile curves: at each step i, compute p05/p50/p95 of cumByRep[*][i].
  const p05 = new Array<number>(N);
  const p50 = new Array<number>(N);
  const p95 = new Array<number>(N);
  const stepBuf = new Array<number>(cfg.replications);
  for (let i = 0; i < N; i++) {
    for (let r = 0; r < cfg.replications; r++) stepBuf[r] = cumByRep[r][i];
    stepBuf.sort((a, b) => a - b);
    p05[i] = percentile(stepBuf, 0.05);
    p50[i] = percentile(stepBuf, 0.50);
    p95[i] = percentile(stepBuf, 0.95);
  }

  const finals = cumByRep.map((c) => c[c.length - 1]);
  finals.sort((a, b) => a - b);
  const probPositive = finals.filter((v) => v > 0).length / finals.length;
  return {
    replications: cfg.replications,
    p05, p50, p95,
    summary: {
      meanFinalPnl: finals.reduce((s, v) => s + v, 0) / finals.length,
      medianFinalPnl: percentile(finals, 0.5),
      p05FinalPnl: percentile(finals, 0.05),
      p95FinalPnl: percentile(finals, 0.95),
      probPositive,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
