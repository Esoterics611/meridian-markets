// regime-tearsheet — the QuantStats-style scorecard for the "take sides" desk (Playbook II P14).
// The OOS gate proves an edge; the forward run produces an equity curve; this turns that curve into
// the honest, BENCHMARK-RELATIVE report a trader/allocator reads: Sharpe, Sortino, maxDD + its
// duration, hit rate, payoff, exposure/turnover, and the return VS a BTC buy-hold over the SAME
// window (excess return + beta + correlation to it). Realised-first: the curve fed in is the
// realised-first equity (realised − fees + funding [+ open mark only as the live tip]); the headline
// total-return is never blended out of an unrealised mark.
//
// Pure + clock-free (curve + benchmark in, metrics out), so it is fully unit-testable on a
// constructed curve. Returns are per-bar; annualisation is via the caller's barsPerYear.

export interface EquityPoint {
  readonly tMs: number;
  /** Realised-first desk equity (USD) at this sample. */
  readonly equityUsd: number;
}

export interface BenchPoint {
  readonly tMs: number;
  /** Benchmark price (BTC) at this sample. */
  readonly price: number;
}

export interface TearsheetInput {
  readonly curve: readonly EquityPoint[];
  /** Benchmark price series over the same window (aligned by index; min length is used). */
  readonly benchmark: readonly BenchPoint[];
  /** Desk capital (USD) — the denominator for returns + drawdown %. */
  readonly capitalUsd: number;
  /** Bars per year for annualising Sharpe/Sortino (e.g. 24·365 for 1h bars). */
  readonly barsPerYear: number;
  /** Optional realised per-round-trip P&L (USD) for hit rate / payoff. */
  readonly perTradePnlUsd?: readonly number[];
  /** Optional fraction of bars holding a position. */
  readonly exposureFrac?: number;
  /** Optional turnover (Σ|traded notional| / capital). */
  readonly turnover?: number;
}

export interface Tearsheet {
  readonly bars: number;
  readonly finalEquityUsd: number;
  readonly totalReturnPct: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly maxDrawdownPct: number;
  readonly maxDrawdownDurationBars: number;
  readonly hitRate: number;
  readonly avgWinUsd: number;
  readonly avgLossUsd: number;
  /** avgWin / |avgLoss| (∞-guard → 0 when no losses). */
  readonly payoffRatio: number;
  readonly exposureFrac: number;
  readonly turnover: number;
  readonly benchmark: {
    readonly totalReturnPct: number;
    /** Desk total return − benchmark total return (pp). */
    readonly excessReturnPct: number;
    /** cov(deskRet, benchRet) / var(benchRet). */
    readonly beta: number;
    /** Pearson correlation of the per-bar return streams. */
    readonly correlation: number;
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (xs.length - 1));
}
function downsideDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  let ss = 0;
  let n = 0;
  for (const x of xs) if (x < 0) { ss += x * x; n++; }
  return n > 0 ? Math.sqrt(ss / n) : 0;
}
function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Build the realised-first scorecard, benchmark-relative to a BTC buy-hold over the same window. */
export function computeTearsheet(input: TearsheetInput): Tearsheet {
  const curve = input.curve;
  const cap = input.capitalUsd > 0 ? input.capitalUsd : 1;
  const n = curve.length;

  // Per-bar desk returns = Δequity / capital (equity is realised-first P&L, ~0-based).
  const deskRet: number[] = [];
  for (let i = 1; i < n; i++) deskRet.push((curve[i].equityUsd - curve[i - 1].equityUsd) / cap);
  // Benchmark per-bar simple returns, aligned by index.
  const m = Math.min(n, input.benchmark.length);
  const benchRet: number[] = [];
  for (let i = 1; i < m; i++) {
    const p0 = input.benchmark[i - 1].price, p1 = input.benchmark[i].price;
    benchRet.push(p0 > 0 ? (p1 - p0) / p0 : 0);
  }
  // align the two streams to the same length for beta/correlation.
  const k = Math.min(deskRet.length, benchRet.length);
  const deskK = deskRet.slice(0, k);
  const benchK = benchRet.slice(0, k);

  const sd = stdev(deskRet);
  const dd = downsideDev(deskRet);
  const ann = Math.sqrt(input.barsPerYear);
  const sharpe = sd > 0 ? (mean(deskRet) / sd) * ann : 0;
  const sortino = dd > 0 ? (mean(deskRet) / dd) * ann : 0;

  // maxDD (% of capital) + its longest underwater duration, from the equity curve.
  let peak = curve.length ? curve[0].equityUsd : 0;
  let peakIdx = 0;
  let maxDdUsd = 0;
  let maxDurBars = 0;
  for (let i = 0; i < n; i++) {
    if (curve[i].equityUsd > peak) { peak = curve[i].equityUsd; peakIdx = i; }
    const ddUsd = peak - curve[i].equityUsd;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
    if (ddUsd > 0 && i - peakIdx > maxDurBars) maxDurBars = i - peakIdx;
  }

  const totalReturnPct = ((curve[n - 1]?.equityUsd ?? 0) - (curve[0]?.equityUsd ?? 0)) / cap * 100;
  const benchTotalPct = m >= 2 && input.benchmark[0].price > 0
    ? (input.benchmark[m - 1].price - input.benchmark[0].price) / input.benchmark[0].price * 100
    : 0;
  const beta = (() => { const vb = stdev(benchK); return vb > 0 ? (pearson(deskK, benchK) * stdev(deskK)) / vb : 0; })();

  // trade stats.
  const trades = input.perTradePnlUsd ?? [];
  const wins = trades.filter((t) => t > 0);
  const losses = trades.filter((t) => t < 0);
  const avgWinUsd = wins.length ? mean(wins) : 0;
  const avgLossUsd = losses.length ? mean(losses) : 0;
  const payoffRatio = avgLossUsd < 0 ? avgWinUsd / Math.abs(avgLossUsd) : 0;

  return {
    bars: n,
    finalEquityUsd: curve[n - 1]?.equityUsd ?? 0,
    totalReturnPct,
    sharpe,
    sortino,
    maxDrawdownPct: (maxDdUsd / cap) * 100,
    maxDrawdownDurationBars: maxDurBars,
    hitRate: trades.length ? wins.length / trades.length : 0,
    avgWinUsd,
    avgLossUsd,
    payoffRatio,
    exposureFrac: input.exposureFrac ?? 0,
    turnover: input.turnover ?? 0,
    benchmark: {
      totalReturnPct: benchTotalPct,
      excessReturnPct: totalReturnPct - benchTotalPct,
      beta,
      correlation: pearson(deskK, benchK),
    },
  };
}
