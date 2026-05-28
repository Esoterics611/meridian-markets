import { Bar } from '../backtest/bar';
import { cointegrationTest } from '../signal/cointegration';

// PairDiscovery — given a symbol universe (map of symbol → bar series), score
// every (a, b) pair on cointegration p-value + OU half-life + ADV-min, then
// rank them. Output is a ranked list with diagnostic columns suitable for the
// Universe card on the Research desk.
//
// Scoring composition (lower score = better candidate):
//   score = pValue
//           + halfLifePenalty(halfLife)
//           + advPenalty(min(advA, advB))
//
// halfLifePenalty floors at 0 for halfLife in [3, 50] bars (the sweet spot)
// and grows otherwise — too short means whipsaw, too long means dead.
// advPenalty discourages illiquid pairs (low min-volume side) so discovery
// surfaces tradeable rather than just statistically-cointegrated pairs.
//
// Acceptance gates (filter before scoring):
//   * cointegrationTest passes only when both series have ≥ minBars samples.
//   * Pairs whose p-value > pValueCutoff are dropped (not just ranked low).
//   * Pairs with halfLifeBars = Infinity are dropped (non-mean-reverting).

export interface PairDiscoveryConfig {
  /** Minimum bar count per symbol for a pair to be eligible. */
  minBars: number;
  /** Hard cutoff on cointegration p-value (e.g., 0.10). */
  pValueCutoff: number;
  /** Lower bound on OU half-life in bars (whipsaw guard). Default 3. */
  minHalfLifeBars?: number;
  /** Upper bound on OU half-life in bars (dead-pair guard). Default 50. */
  maxHalfLifeBars?: number;
  /** Minimum ADV (per-bar volume mean) the THIN side of the pair must clear. */
  minAdv?: number;
}

export interface PairCandidate {
  symbolA: string;
  symbolB: string;
  beta: number;
  pValue: number;
  halfLifeBars: number;
  advA: number;
  advB: number;
  score: number;
}

const DEFAULT_MIN_HALF_LIFE = 3;
const DEFAULT_MAX_HALF_LIFE = 50;

export function discoverPairs(
  universe: Map<string, Bar[]>,
  cfg: PairDiscoveryConfig,
): PairCandidate[] {
  const symbols = [...universe.keys()];
  const out: PairCandidate[] = [];

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i];
      const b = symbols[j];
      const barsA = universe.get(a)!;
      const barsB = universe.get(b)!;
      if (barsA.length < cfg.minBars || barsB.length < cfg.minBars) continue;
      const n = Math.min(barsA.length, barsB.length);
      const logA = new Array<number>(n);
      const logB = new Array<number>(n);
      for (let k = 0; k < n; k++) {
        logA[k] = Math.log(barsA[k].close);
        logB[k] = Math.log(barsB[k].close);
      }
      let coint;
      try {
        coint = cointegrationTest(logA, logB);
      } catch {
        continue;
      }
      if (coint.pValue > cfg.pValueCutoff) continue;
      if (!Number.isFinite(coint.halfLifeBars)) continue;
      const minHl = cfg.minHalfLifeBars ?? DEFAULT_MIN_HALF_LIFE;
      const maxHl = cfg.maxHalfLifeBars ?? DEFAULT_MAX_HALF_LIFE;
      if (coint.halfLifeBars < minHl || coint.halfLifeBars > maxHl) continue;
      const advA = meanVolume(barsA);
      const advB = meanVolume(barsB);
      if (cfg.minAdv !== undefined && Math.min(advA, advB) < cfg.minAdv) continue;
      const score = compositeScore({
        pValue: coint.pValue,
        halfLifeBars: coint.halfLifeBars,
        advMin: Math.min(advA, advB),
      });
      out.push({
        symbolA: a,
        symbolB: b,
        beta: coint.beta,
        pValue: coint.pValue,
        halfLifeBars: coint.halfLifeBars,
        advA,
        advB,
        score,
      });
    }
  }

  out.sort((x, y) => x.score - y.score);
  return out;
}

function meanVolume(bars: Bar[]): number {
  if (bars.length === 0) return 0;
  let s = 0;
  for (const b of bars) s += b.volume;
  return s / bars.length;
}

function compositeScore(x: { pValue: number; halfLifeBars: number; advMin: number }): number {
  // pValue is the dominant component; tighter pValue = better.
  const pPart = x.pValue;
  // half-life sweet spot is [5, 30]; penalise outside.
  const SWEET_LO = 5, SWEET_HI = 30;
  let hlPart = 0;
  if (x.halfLifeBars < SWEET_LO) hlPart = (SWEET_LO - x.halfLifeBars) * 0.02;
  else if (x.halfLifeBars > SWEET_HI) hlPart = (x.halfLifeBars - SWEET_HI) * 0.005;
  // ADV penalty diminishes as ADV grows; cap so it doesn't dominate.
  const advPart = Math.min(0.1, 1 / Math.max(1, x.advMin));
  return pPart + hlPart + advPart;
}
