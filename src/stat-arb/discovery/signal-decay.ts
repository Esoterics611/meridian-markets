// SignalDecayTracker — given a per-trade P&L stream for a pair, computes the
// rolling Sharpe ratio over a window and flags decay when the recent window's
// Sharpe drops below a fraction of the historical median. This is how a desk
// notices that a pair "stopped working" before they lose another full
// drawdown's worth of risk capital.
//
// Inputs are intentionally PnL-per-trade, not bar-level. Sharpe at the trade
// level is more informative for stat-arb (each trade is one realised round-trip)
// and avoids the regime-dependence of per-bar mark-to-market.
//
// Notes on the math:
//   * Sharpe = mean(pnl) / std(pnl); we don't annualise here (Sharpe is in
//     "per-trade" units). The dashboard rolls into the appropriate horizon.
//   * Decay flag fires when the most recent `windowTrades` Sharpe drops
//     below `decayRatio × historical_median_Sharpe`.
//   * "Historical median" is computed over all overlapping windows of size
//     `windowTrades` in the trade stream excluding the most recent window.
//     This is a robust baseline that ignores the head and tail of a series.

export interface SignalDecayConfig {
  /** Rolling window in trades. Must be >= 3. */
  windowTrades: number;
  /** Recent Sharpe / historical median below this fraction → decay. Default 0.5. */
  decayRatio: number;
  /** Hard floor: if historical median Sharpe is < this, treat baseline as zero. Default 0.1. */
  minBaselineSharpe?: number;
}

export interface SignalDecayResult {
  /** Sharpe over the trailing `windowTrades` window. NaN when window can't fill. */
  recentSharpe: number;
  /** Median rolling-Sharpe baseline (excludes the trailing window). */
  baselineSharpe: number;
  /** True iff recent / baseline < decayRatio. */
  decayed: boolean;
  /** Number of trades the result is computed from. */
  tradeCount: number;
}

export function detectSignalDecay(
  pnlPerTrade: number[],
  cfg: SignalDecayConfig,
): SignalDecayResult {
  if (cfg.windowTrades < 3) {
    throw new Error('detectSignalDecay: windowTrades must be >= 3');
  }
  const n = pnlPerTrade.length;
  if (n < cfg.windowTrades) {
    return { recentSharpe: NaN, baselineSharpe: NaN, decayed: false, tradeCount: n };
  }

  const recentWindow = pnlPerTrade.slice(n - cfg.windowTrades);
  const recentSharpe = sharpe(recentWindow);

  // Historical rolling windows exclude the most recent window so the baseline
  // isn't contaminated by the same period we're testing.
  const historical: number[] = [];
  for (let end = cfg.windowTrades; end < n; end++) {
    historical.push(sharpe(pnlPerTrade.slice(end - cfg.windowTrades, end)));
  }
  const baselineSharpe = historical.length === 0 ? NaN : median(historical);

  const floor = cfg.minBaselineSharpe ?? 0.1;
  let decayed = false;
  if (!Number.isNaN(recentSharpe) && !Number.isNaN(baselineSharpe)) {
    const effectiveBaseline = Math.abs(baselineSharpe) < floor ? 0 : baselineSharpe;
    if (effectiveBaseline > 0) {
      decayed = recentSharpe < cfg.decayRatio * effectiveBaseline;
    } else if (effectiveBaseline < 0) {
      // If baseline is already negative, "decay" means more negative.
      decayed = recentSharpe < effectiveBaseline;
    }
  }

  return { recentSharpe, baselineSharpe, decayed, tradeCount: n };
}

function sharpe(pnl: number[]): number {
  if (pnl.length < 2) return NaN;
  const mean = pnl.reduce((s, v) => s + v, 0) / pnl.length;
  let sq = 0;
  for (const v of pnl) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / pnl.length);
  if (std === 0) return 0;
  return mean / std;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
