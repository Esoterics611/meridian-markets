// regime-cross-sectional — the CROSS-SECTIONAL momentum/rank signal (Playbook II P12, the
// headline expansion). Every other regime signal is computed from ONE symbol's own history;
// this one ranks the WHOLE universe at each bar and expresses "long the strongest, short the
// weakest" — the classic cross-sectional momentum factor. It is what turns the desk from a
// bag of independent single-name bets into a relative-value book.
//
// Pure + no-look-ahead: at bar i the rank uses only each symbol's trailing L-bar return
// computed from prices up to i. A symbol with no defined trailing return at i (warmup / a
// price gap) is excluded from that bar's ranking and gets NaN (no view), exactly like the
// per-symbol signals — buildSignalForwardPairs drops those, so the OOS gate is honest.
//
// The bias is a DEMEANED, [-1,1]-scaled rank: the top name → +1, the bottom → −1, the median
// → 0, linearly between. Feeding each symbol's own forward return into the SAME oosForwardReturnIc
// gate measures whether the cross-sectional rank predicts that symbol's forward move — no
// special-casing, one honesty bar for every signal.

import { trailingMomentum } from './regime-signals';

/** A universe member's aligned price history (prices[i] at barTimesMs[i], ascending). */
export interface CrossSectionalSeries {
  readonly symbol: string;
  readonly prices: readonly number[];
  readonly barTimesMs: readonly number[];
}

/**
 * Per-symbol cross-sectional rank bias series over the universe. `out.get(sym)[i]` ∈ [−1,1]
 * (NaN where the symbol has no trailing return at i or fewer than two names rank that bar).
 * All series are assumed bar-aligned (same length / timestamps) — the runner loads them so.
 */
export function crossSectionalRankSignals(
  universe: readonly CrossSectionalSeries[],
  lookbackBars: number,
): Map<string, number[]> {
  const n = universe.length;
  const len = universe.reduce((m, u) => Math.max(m, u.prices.length), 0);
  const mom = universe.map((u) => trailingMomentum(u.prices, lookbackBars));
  const out = new Map<string, number[]>();
  for (const u of universe) out.set(u.symbol, new Array(u.prices.length).fill(NaN));

  for (let i = 0; i < len; i++) {
    // collect the names with a defined trailing return at bar i.
    const present: { idx: number; mom: number }[] = [];
    for (let k = 0; k < n; k++) {
      const v = mom[k][i];
      if (Number.isFinite(v)) present.push({ idx: k, mom: v });
    }
    if (present.length < 2) continue; // need a cross-section to rank
    present.sort((a, b) => a.mom - b.mom); // ascending: weakest first
    const m = present.length;
    for (let r = 0; r < m; r++) {
      // rank 0..m-1 → [−1, +1] demeaned (top = +1, bottom = −1, median = 0).
      const bias = m === 1 ? 0 : (2 * r) / (m - 1) - 1;
      out.get(universe[present[r].idx].symbol)![i] = bias;
    }
  }
  return out;
}
