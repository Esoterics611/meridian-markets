// Survivorship-robustness gate for equities OOS results (P0.5 — the free, no-data path).
//
// An OOS backtest run over TODAY's listed tickers (the hardcoded `EQUITY_PRESETS`)
// is survivor-only: names that delisted INSIDE the window — the 2008 bank casualties
// (Wachovia, WaMu, National City, Bear, Lehman, Countrywide…), the 2020 bankruptcies —
// are simply absent. Their spreads NEVER mean-reverted (a failed bank's pair blows out
// and stays out), so they never enter the P&L, while the survivors — whose spreads DID
// revert — do. The bias is therefore one-directional (it only ever flatters the Sharpe)
// and it GROWS with window length: the further back you reach, the more dead names you
// have silently dropped. Journal #13 measured exactly this on the de-biased basket —
// pooled Sharpe 0.06 → 0.09 → 0.15 as the window grew 5yr → 10yr → 24yr. A Sharpe that
// rises monotonically with history is the signature of survivorship, not a stable edge.
//
// The clean fix is a delisted-inclusive, point-in-time universe (Sharadar / CRSP) — the
// PAID data path the desk declined (SURVIVORSHIP_DATA_OPTIONS.md). Without it, the only
// honest FREE move is to trust ONLY a window short enough that the survivor set ≈ the
// live set, and to treat any longer-window result as an UPPER BOUND, never a deploy
// verdict. Over the last ~5yr almost no large-cap sector name has gone to zero (the few
// exits — PXD/MRO 2024 — were acquisitions that settled near a price, not bankruptcies
// that blew the spread out), so survivor ≈ live and the bias is negligible. Reaching
// through the 2008 / 2020 crises it is not. This module encodes that horizon so the
// tooling itself refuses to re-trust the long-window number (Journal #14).

/**
 * Survivor-safe horizon, in days. ~5yr: long enough for a real OOS trade count, short
 * enough that the large-cap sector baskets had effectively no in-window bankruptcies, so
 * today's survivor set ≈ the live set as-of the window start. A heuristic, not a guarantee
 * of zero bias — its job is to exclude the crisis casualties that do the bulk of the
 * inflating. Tune via `OOS_SURVIVOR_SAFE_DAYS`.
 */
export const DEFAULT_SURVIVOR_SAFE_DAYS = 1825;

export interface SurvivorshipAssessment {
  /** The OOS lookback window actually requested. */
  windowDays: number;
  /** The survivor-safe horizon used for the judgement. */
  safeDays: number;
  /** True iff windowDays ≤ safeDays — survivor set ≈ live set, bias negligible. */
  survivorSafe: boolean;
  /** Years the window reaches PAST the safe horizon (0 when survivor-safe). */
  excessYears: number;
  /** Human-readable one-liner for the console banner + the JSON artifact. */
  note: string;
}

/**
 * Judge whether an OOS window is short enough that the survivor-only `EQUITY_PRESETS`
 * universe is a defensible stand-in for the point-in-time universe. Pure + offline.
 */
export function assessSurvivorship(
  windowDays: number,
  safeDays: number = DEFAULT_SURVIVOR_SAFE_DAYS,
): SurvivorshipAssessment {
  const survivorSafe = windowDays <= safeDays;
  const excessYears = Math.max(0, (windowDays - safeDays) / 365);
  const safeYrs = (safeDays / 365).toFixed(1);
  const winYrs = (windowDays / 365).toFixed(1);
  const note = survivorSafe
    ? `window ${winYrs}yr ≤ ${safeYrs}yr survivor-safe horizon — survivor set ≈ live set, survivorship bias negligible`
    : `window ${winYrs}yr reaches ${excessYears.toFixed(1)}yr past the ${safeYrs}yr survivor-safe horizon — ` +
      `survivor-only universe drops the in-window casualties ⇒ the Sharpe is an UPPER BOUND, not a deploy verdict`;
  return { windowDays, safeDays, survivorSafe, excessYears, note };
}

/** Base statistical verdict (from the DSR/PSR/trade-count gate), before survivorship. */
export type BaseVerdict = 'PASS' | 'INSUFFICIENT' | 'NOISE' | 'INCONCLUSIVE';
/** Final deploy verdict — `UPPER-BOUND` is added when survivorship caps an otherwise-OK result. */
export type DeployVerdict = BaseVerdict | 'UPPER-BOUND';

/**
 * Fold the survivorship dimension into the base statistical verdict.
 *
 * On a survivor-UNSAFE window, a statistically-strong read (PASS) — or one that merely
 * couldn't be ruled out (INCONCLUSIVE) — is downgraded to UPPER-BOUND: no PSR/DSR, however
 * high, can certify a deploy when the level is inflated by survivors-only crisis
 * mean-reversion. A verdict that already says "no" (NOISE / INSUFFICIENT) is left as-is —
 * survivorship only ever flatters, so it cannot turn a "no" into a worse "no". Survivor-safe
 * windows pass through unchanged.
 */
export function applySurvivorshipGate(base: BaseVerdict, survivorSafe: boolean): DeployVerdict {
  if (survivorSafe) return base;
  return base === 'PASS' || base === 'INCONCLUSIVE' ? 'UPPER-BOUND' : base;
}
