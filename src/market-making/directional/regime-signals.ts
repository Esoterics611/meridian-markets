// regime-signals — the PURE, no-look-ahead per-bar signal library for the standalone
// "take sides" book (REGIME_DIRECTIONAL_BOOK.md, playbook S1/P2). It is the SINGLE
// definition of the candidate directional signals, shared by two consumers so they
// can never drift apart:
//   • the OFFLINE OOS gate (scripts/regime-bias-oos.ts) that decides which symbols are
//     VALIDATED to trade today, and
//   • the LIVE runner / bias sources (playbook S3+) that size a position from the same
//     signal value the gate validated.
//
// Every signal here is computed from data up to bar t ONLY — the correctness of the
// forward-return gate (forward-return-ic.ts) depends on it, so no function may read a
// future bar or a future funding settlement. A bar with no defined value yields NaN
// (buildSignalForwardPairs drops those), never a silently-imputed 0.
//
// The two interpretable signals (no ML — CLAUDE.md doctrine), each already validated
// in the directional-bias sweep:
//   1. funding-paid-side: bias = −trailing-mean funding ("be long the funding-PAID
//      side"). +funding ⇒ longs pay ⇒ SHORT is paid ⇒ bias < 0.
//   2. momentum: bias = trailing L-bar log return ("be long the trend").

import { FundingPoint } from '../../market-data/funding/funding-source.interface';
import { buildSignalForwardPairs, SignalForwardPair } from '../bias/oos/forward-return-ic';

/** The real history a symbol's signals are computed from (prices + funding tape). */
export interface RegimeSeries {
  /** Close prices, oldest→newest. */
  readonly prices: readonly number[];
  /** Bar close times (ms epoch), aligned 1:1 with `prices`, ascending. */
  readonly barTimesMs: readonly number[];
  /** Funding settlements (any order); each carries fundingTimeMs + fundingRate. */
  readonly funding: readonly FundingPoint[];
}

/**
 * Trailing mean funding rate (per settlement) at each bar, using only settlements
 * at or before the bar time and within the trailing `windowHours`. NaN when no
 * settlement falls in the window (the symbol expresses no funding view there).
 *
 * Strictly past data only: a settlement with `fundingTimeMs > t` is excluded, so
 * there is no look-ahead even when a settlement lands exactly on a bar boundary.
 */
export function trailingFundingPerHour(
  barTimesMs: readonly number[],
  funding: readonly FundingPoint[],
  windowHours: number,
): number[] {
  const sorted = [...funding].sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  const winMs = windowHours * 3_600_000;
  const out: number[] = new Array(barTimesMs.length).fill(NaN);
  for (let i = 0; i < barTimesMs.length; i++) {
    const t = barTimesMs[i];
    let sum = 0;
    let cnt = 0;
    for (const f of sorted) {
      if (f.fundingTimeMs > t) break; // strictly past data only
      if (f.fundingTimeMs > t - winMs) {
        sum += f.fundingRate;
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}

/**
 * The funding-paid-side BIAS signal: −trailing-mean funding. A POSITIVE IC on this
 * signal means leaning the funding-paid side predicts forward return (the distinct,
 * stronger claim than merely harvesting carry).
 */
export function fundingPaidSideSignal(
  barTimesMs: readonly number[],
  funding: readonly FundingPoint[],
  windowHours: number,
): number[] {
  return trailingFundingPerHour(barTimesMs, funding, windowHours).map((f) => (Number.isFinite(f) ? -f : NaN));
}

/**
 * Trailing L-bar log return at each bar (data up to t only): log(P[i]/P[i−L]). The
 * first `lookbackBars` entries — and any bar touching a non-positive price — are NaN.
 */
export function trailingMomentum(prices: readonly number[], lookbackBars: number): number[] {
  const lb = Math.max(1, Math.floor(lookbackBars));
  const out: number[] = new Array(prices.length).fill(NaN);
  for (let i = lb; i < prices.length; i++) {
    const p0 = prices[i - lb];
    const p1 = prices[i];
    out[i] = p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : NaN;
  }
  return out;
}

/** The candidate signal families the regime board screens. */
export type RegimeSignalKind = 'funding-paid-side' | 'momentum';

/** A single candidate directional signal (a family + its one parameter). */
export interface RegimeSignalSpec {
  /** Display name on the board, e.g. 'funding-paid-side(24h)' or 'momentum(72h)'. */
  readonly name: string;
  readonly kind: RegimeSignalKind;
  /** Momentum lookback in BARS (momentum only). */
  readonly lookbackBars?: number;
  /** Trailing-funding window in HOURS (funding only). */
  readonly windowHours?: number;
}

/**
 * The per-bar signal series for a spec over a symbol's history (NaN where undefined).
 * Dispatching here — not in the script — is what keeps the gate and the live runner
 * computing the exact same number for the exact same spec.
 */
export function regimeSignalSeries(spec: RegimeSignalSpec, series: RegimeSeries): number[] {
  switch (spec.kind) {
    case 'funding-paid-side':
      return fundingPaidSideSignal(series.barTimesMs, series.funding, spec.windowHours ?? 24);
    case 'momentum':
      return trailingMomentum(series.prices, spec.lookbackBars ?? 24);
  }
}

/**
 * The (signal, forwardReturn) pairs for a spec at a forward horizon, ready for the
 * OOS gate (oosForwardReturnIc). Reuses buildSignalForwardPairs (drops non-finite /
 * zero signals and pairs whose forward window runs off the end).
 */
export function regimeSignalPairs(
  spec: RegimeSignalSpec,
  series: RegimeSeries,
  horizonBars: number,
): SignalForwardPair[] {
  return buildSignalForwardPairs(series.prices as number[], regimeSignalSeries(spec, series), horizonBars);
}

/** Options for the default candidate set (lookbacks/windows are expressed in HOURS). */
export interface DefaultSpecOptions {
  /** Interval length of one bar, in hours (e.g. 1 for '1h'), to convert hour-lookbacks to bars. */
  readonly intervalHours: number;
  /** Momentum lookbacks in HOURS. Default [24, 72]. */
  readonly momentumLookbackHours?: readonly number[];
  /** Trailing-funding windows in HOURS. Default [24]. */
  readonly fundingWindowHours?: readonly number[];
}

/**
 * The default candidate signal set the regime board screens per symbol: the funding-
 * paid-side signal at each funding window, plus momentum at each lookback. Hours are
 * converted to bars via `intervalHours` so the same spec means the same thing at any
 * bar interval.
 */
export function defaultRegimeSignalSpecs(opts: DefaultSpecOptions): RegimeSignalSpec[] {
  const iv = opts.intervalHours > 0 ? opts.intervalHours : 1;
  const momHours = opts.momentumLookbackHours ?? [24, 72];
  const fundHours = opts.fundingWindowHours ?? [24];
  const specs: RegimeSignalSpec[] = [];
  for (const wh of fundHours) {
    specs.push({ name: `funding-paid-side(${wh}h)`, kind: 'funding-paid-side', windowHours: wh });
  }
  for (const lh of momHours) {
    specs.push({ name: `momentum(${lh}h)`, kind: 'momentum', lookbackBars: Math.max(1, Math.round(lh / iv)) });
  }
  return specs;
}
