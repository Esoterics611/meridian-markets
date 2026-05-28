// PnL attribution + summary metrics for backtest results.
//
// A "trade" here is a round-trip pair-leg cycle: open at entry z-score,
// close at exit z-score. P&L is computed in USDC units (6-decimal) so it
// stays bigint-exact at the boundary; intermediate ratios are float.

import { TradeRecord } from './backtest-runner';

export interface BacktestMetrics {
  totalPnlUnits: bigint;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  totalTrades: number;
}

export function summarize(trades: TradeRecord[]): BacktestMetrics {
  if (trades.length === 0) {
    return { totalPnlUnits: 0n, sharpeRatio: 0, maxDrawdownPct: 0, winRate: 0, totalTrades: 0 };
  }

  let total = 0n;
  let wins = 0;
  const pnls = new Array<number>(trades.length);
  for (let i = 0; i < trades.length; i++) {
    const p = trades[i].pnlUnits;
    total += p;
    pnls[i] = Number(p);
    if (p > 0n) wins++;
  }

  // Sharpe: mean / std of per-trade P&L, annualised assuming ~252 trades/year
  // would be wrong for a tick backtest — but as a dimensionless metric on
  // the demo it conveys "risk-adjusted return" without misleading scaling.
  // Use raw Sharpe per trade (no annualisation) — that's the convention in
  // statistical-arbitrage backtests of this kind.
  let mean = 0;
  for (let i = 0; i < pnls.length; i++) mean += pnls[i];
  mean /= pnls.length;
  let variance = 0;
  for (let i = 0; i < pnls.length; i++) {
    const d = pnls[i] - mean;
    variance += d * d;
  }
  variance /= Math.max(1, pnls.length - 1);
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? mean / std : 0;

  // Max drawdown: largest peak-to-trough drop in cumulative P&L.
  let peak = 0;
  let cum = 0;
  let maxDdAbs = 0;
  for (let i = 0; i < pnls.length; i++) {
    cum += pnls[i];
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDdAbs) maxDdAbs = dd;
  }
  // Drawdown as a percentage of peak equity. If peak is 0 (no positive runs),
  // express it relative to total absolute volume to keep the metric defined.
  const denominator = peak > 0 ? peak : Math.max(1, Math.abs(mean) * pnls.length);
  const maxDrawdownPct = (maxDdAbs / denominator) * 100;

  return {
    totalPnlUnits: total,
    sharpeRatio,
    maxDrawdownPct,
    winRate: wins / trades.length,
    totalTrades: trades.length,
  };
}
