/**
 * calibration-score — Brier(RND fair) vs Brier(market mid) at settlement (PURE, no I/O).
 *
 * The #96 pre-registered gate for the (parked) position book: every settling binary
 * hands us a free (model fair, market mid, outcome) triple, no position required. At
 * fixed horizons before expiry we freeze the FIRST observation past each boundary
 * (pre-registered — no cherry-picking the flattering snapshot), and at settle each
 * frozen horizon contributes one Brier pair. After ≥100 settles a paired bootstrap CI
 * on mean(brierMid − brierFair) decides: fair wins clear of zero ⇒ the model is better
 * calibrated than the crowd; loses ⇒ the position book dies. The maker book (Phase 0/1)
 * is NOT gated on this — see docs/PREDICTION_MARKET_MM_RESEARCH.md §4.
 */

export const DEFAULT_HORIZONS_H = [6, 3, 1];

export interface BrierContribution {
  marketId: string;
  horizonH: number;
  /** Model fair and market mid frozen at the horizon. */
  fair: number;
  mid: number;
  /** Settled outcome, 1 = YES. */
  y: 0 | 1;
}

interface FrozenHorizon {
  horizonH: number;
  fair: number;
  mid: number;
  ms: number;
}

interface MarketState {
  expiryMs: number;
  frozen: Map<number, FrozenHorizon>;
}

/**
 * Accumulates horizon snapshots per market and emits Brier contributions at settle.
 * In-memory only — restarting mid-window loses the current markets' frozen horizons
 * (acceptable: the tape can always be re-scored offline).
 */
export class CalibrationBook {
  private markets = new Map<string, MarketState>();
  private contribs: BrierContribution[] = [];

  constructor(private readonly horizonsH: number[] = DEFAULT_HORIZONS_H) {}

  /** Feed every priced tick; freezes the first observation past each horizon. */
  onSnap(marketId: string, expiryMs: number, ms: number, fair: number, mid: number): void {
    let st = this.markets.get(marketId);
    if (!st) {
      st = { expiryMs, frozen: new Map() };
      this.markets.set(marketId, st);
    }
    const hoursLeft = (expiryMs - ms) / 3_600_000;
    for (const h of this.horizonsH) {
      if (hoursLeft <= h && !st.frozen.has(h)) {
        st.frozen.set(h, { horizonH: h, fair, mid, ms });
      }
    }
  }

  /** Settle a market; returns (and retains) the contributions it produced. */
  onSettle(marketId: string, settledYes: boolean): BrierContribution[] {
    const st = this.markets.get(marketId);
    if (!st) return [];
    const y: 0 | 1 = settledYes ? 1 : 0;
    const out: BrierContribution[] = [...st.frozen.values()].map((f) => ({
      marketId,
      horizonH: f.horizonH,
      fair: f.fair,
      mid: f.mid,
      y,
    }));
    this.contribs.push(...out);
    this.markets.delete(marketId);
    return out;
  }

  all(): BrierContribution[] {
    return [...this.contribs];
  }
}

export interface BrierSummary {
  n: number;
  settles: number;
  brierFair: number;
  brierMid: number;
  /** mean(brierMid − brierFair): POSITIVE ⇒ the model fair is better calibrated. */
  meanDiff: number;
}

export function brierSummary(contribs: BrierContribution[], horizonH?: number): BrierSummary {
  const rows = horizonH === undefined ? contribs : contribs.filter((c) => c.horizonH === horizonH);
  const n = rows.length;
  if (n === 0) return { n: 0, settles: 0, brierFair: NaN, brierMid: NaN, meanDiff: NaN };
  let sf = 0;
  let sm = 0;
  for (const c of rows) {
    sf += (c.fair - c.y) ** 2;
    sm += (c.mid - c.y) ** 2;
  }
  return {
    n,
    settles: new Set(rows.map((c) => c.marketId)).size,
    brierFair: sf / n,
    brierMid: sm / n,
    meanDiff: (sm - sf) / n,
  };
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible in specs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  meanDiff: number;
  lo95: number;
  hi95: number;
  resamples: number;
  settles: number;
}

/**
 * Paired bootstrap over SETTLES (each settle's horizon-contributions move together —
 * they share one outcome and are not independent) of mean(brierMid − brierFair).
 * lo95 > 0 ⇒ the model fair is better calibrated, clear of zero.
 */
export function bootstrapDiffCI(
  contribs: BrierContribution[],
  resamples = 10_000,
  seed = 20260714,
): BootstrapCI {
  const bySettle = new Map<string, number[]>();
  for (const c of contribs) {
    const diff = (c.mid - c.y) ** 2 - (c.fair - c.y) ** 2;
    const arr = bySettle.get(c.marketId) ?? [];
    arr.push(diff);
    bySettle.set(c.marketId, arr);
  }
  const settleMeans = [...bySettle.values()].map(
    (ds) => ds.reduce((s, d) => s + d, 0) / ds.length,
  );
  const k = settleMeans.length;
  const overall = k ? settleMeans.reduce((s, d) => s + d, 0) / k : NaN;
  if (k < 2) return { meanDiff: overall, lo95: NaN, hi95: NaN, resamples: 0, settles: k };
  const rnd = mulberry32(seed);
  const means: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (let jj = 0; jj < k; jj++) s += settleMeans[Math.floor(rnd() * k)];
    means[i] = s / k;
  }
  means.sort((a, b) => a - b);
  return {
    meanDiff: overall,
    lo95: means[Math.floor(0.025 * resamples)],
    hi95: means[Math.min(resamples - 1, Math.floor(0.975 * resamples))],
    resamples,
    settles: k,
  };
}
