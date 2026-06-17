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

/**
 * Trailing realised volatility at each bar: sample stdev of the last `lookbackBars`
 * one-bar log returns ending at i (data up to t only). NaN until `lookbackBars+1`
 * prices are available or when any price in the window is non-positive.
 */
export function trailingRealisedVol(prices: readonly number[], lookbackBars: number): number[] {
  const lb = Math.max(2, Math.floor(lookbackBars));
  const out: number[] = new Array(prices.length).fill(NaN);
  for (let i = lb; i < prices.length; i++) {
    const rets: number[] = [];
    let ok = true;
    for (let j = i - lb + 1; j <= i; j++) {
      const p0 = prices[j - 1];
      const p1 = prices[j];
      if (!(p0 > 0) || !(p1 > 0)) { ok = false; break; }
      rets.push(Math.log(p1 / p0));
    }
    if (!ok || rets.length < 2) continue;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    let ss = 0;
    for (const r of rets) ss += (r - mean) * (r - mean);
    out[i] = Math.sqrt(ss / (rets.length - 1));
  }
  return out;
}

/**
 * The SHORT-TERM REVERSAL bias: −trailing L-bar log return ("fade the recent pop").
 * The contrarian counterpart to momentum — a positive IC means a recent UP move
 * predicts a forward DOWN move (mean reversion) on this symbol/horizon.
 */
export function trailingReversal(prices: readonly number[], lookbackBars: number): number[] {
  return trailingMomentum(prices, lookbackBars).map((m) => (Number.isFinite(m) ? -m : NaN));
}

/**
 * VOL-SCALED MOMENTUM: trailing L-bar return divided by trailing realised vol over the
 * same lookback — a risk-adjusted trend (a 2% trend in a calm tape is a stronger view
 * than a 2% trend in a noisy one). NaN where momentum or vol is undefined / vol is 0.
 */
export function volScaledMomentum(prices: readonly number[], lookbackBars: number): number[] {
  const mom = trailingMomentum(prices, lookbackBars);
  const vol = trailingRealisedVol(prices, lookbackBars);
  // Floor numerically-degenerate vol (a constant-growth path leaves only FP residue ~1e-16) to
  // "no view" — dividing a real trend by ~0 risk would otherwise yield an absurd, meaningless bias.
  const VOL_EPS = 1e-12;
  return mom.map((m, i) => (Number.isFinite(m) && Number.isFinite(vol[i]) && vol[i] > VOL_EPS ? m / vol[i] : NaN));
}

/** The candidate signal families the regime board screens. `cross-sectional-momentum` is
 *  UNIVERSE-WIDE (needs every symbol) so it is computed by regime-cross-sectional.ts and fed to
 *  the board as a precomputed ExtraSignal — never derived from one symbol via regimeSignalSeries. */
export type RegimeSignalKind = 'funding-paid-side' | 'momentum' | 'reversal' | 'vol-scaled-momentum' | 'cross-sectional-momentum';

/** A single candidate directional signal (a family + its one parameter). */
export interface RegimeSignalSpec {
  /** Display name on the board, e.g. 'funding-paid-side(24h)' or 'momentum(72h)'. */
  readonly name: string;
  readonly kind: RegimeSignalKind;
  /** Lookback in BARS (momentum / reversal / vol-scaled-momentum). */
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
    case 'reversal':
      return trailingReversal(series.prices, spec.lookbackBars ?? 6);
    case 'vol-scaled-momentum':
      return volScaledMomentum(series.prices, spec.lookbackBars ?? 24);
    case 'cross-sectional-momentum':
      // Universe-wide — cannot be derived from one symbol's series. Computed by
      // crossSectionalRankSignals() and supplied to the board as a precomputed ExtraSignal.
      return new Array(series.prices.length).fill(NaN);
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
  /** Short-term reversal lookbacks in HOURS (P12). Default [6, 12]. Empty ⇒ no reversal candidates. */
  readonly reversalLookbackHours?: readonly number[];
  /** Vol-scaled-momentum lookbacks in HOURS (P12). Default [24, 72]. Empty ⇒ none. */
  readonly volScaledMomentumLookbackHours?: readonly number[];
}

/**
 * The default candidate signal set the regime board screens per symbol: funding-paid-side
 * at each window, momentum + vol-scaled-momentum at each lookback, and short-term reversal.
 * (P12 widened the family set — each new signal is pure + no-look-ahead + OOS-gated, so a
 * bigger candidate set is safe: most won't validate, which is the correct outcome.) Hours
 * convert to bars via `intervalHours` so the same spec means the same thing at any interval.
 */
export function defaultRegimeSignalSpecs(opts: DefaultSpecOptions): RegimeSignalSpec[] {
  const iv = opts.intervalHours > 0 ? opts.intervalHours : 1;
  const toBars = (h: number) => Math.max(1, Math.round(h / iv));
  const momHours = opts.momentumLookbackHours ?? [24, 72];
  const fundHours = opts.fundingWindowHours ?? [24];
  const revHours = opts.reversalLookbackHours ?? [6, 12];
  const vsmHours = opts.volScaledMomentumLookbackHours ?? [24, 72];
  const specs: RegimeSignalSpec[] = [];
  for (const wh of fundHours) specs.push({ name: `funding-paid-side(${wh}h)`, kind: 'funding-paid-side', windowHours: wh });
  for (const lh of momHours) specs.push({ name: `momentum(${lh}h)`, kind: 'momentum', lookbackBars: toBars(lh) });
  for (const lh of vsmHours) specs.push({ name: `vol-scaled-momentum(${lh}h)`, kind: 'vol-scaled-momentum', lookbackBars: toBars(lh) });
  for (const lh of revHours) specs.push({ name: `reversal(${lh}h)`, kind: 'reversal', lookbackBars: toBars(lh) });
  return specs;
}
