import { cointegrationTest } from '../signal/cointegration';

// RegimeDetector — classifies the current market state from a price series.
// Three sub-signals:
//
//   1. Volatility regime — low / normal / high based on realised vol vs the
//      rolling lookback. Used to scale entry sizing and pause when vol spikes.
//   2. Trend regime — trending / range from the OLS slope of log-prices over
//      the same lookback. Pair strategies want range; outright trend-follow
//      strategies want trending. The Universe card uses this to colour pairs.
//   3. Decoupling alarm — for a *cointegrated pair*, the rolling Engle-Granger
//      p-value over the lookback window. p > pValueAlarm triggers; the pair
//      is no longer mean-reverting and entries should pause.
//
// All three are pure functions over the input series. No state. Same
// determinism contract as the rest of the signal library.

export type VolRegime = 'LOW' | 'NORMAL' | 'HIGH';
export type TrendRegime = 'RANGE' | 'TRENDING';

export interface RegimeConfig {
  /** Rolling lookback in bars. Must be >= 10. Default 60. */
  lookbackBars: number;
  /** Vol is HIGH when realised > volHighMult × historical median. Default 1.7. */
  volHighMult: number;
  /** Vol is LOW when realised < volLowMult × historical median. Default 0.6. */
  volLowMult: number;
  /** Absolute |slope|·N threshold for TRENDING. Default 0.05 (5% log-return over lookback). */
  trendSlopeThreshold: number;
  /** p-value above which the decoupling alarm fires. Default 0.10. */
  decouplingPValueAlarm: number;
}

export interface RegimeAssessment {
  vol: VolRegime;
  trend: TrendRegime;
  decoupling: boolean;
  /** Realised standard deviation of log-returns over the lookback. */
  realisedVol: number;
  /** OLS slope of log-prices over the lookback. */
  trendSlope: number;
  /** Cointegration p-value when both series provided; null otherwise. */
  pValue: number | null;
}

const DEFAULTS: RegimeConfig = {
  lookbackBars: 60,
  volHighMult: 1.7,
  volLowMult: 0.6,
  trendSlopeThreshold: 0.05,
  decouplingPValueAlarm: 0.10,
};

export function detectRegime(
  logPricesA: number[],
  logPricesB: number[] | null = null,
  cfgOverrides: Partial<RegimeConfig> = {},
): RegimeAssessment {
  const cfg = { ...DEFAULTS, ...cfgOverrides };
  if (cfg.lookbackBars < 10) throw new Error('detectRegime: lookbackBars must be >= 10');
  if (logPricesA.length < cfg.lookbackBars) {
    throw new Error(`detectRegime: need >= ${cfg.lookbackBars} samples, got ${logPricesA.length}`);
  }

  const window = logPricesA.slice(-cfg.lookbackBars);
  const realisedVol = stdLogReturns(window);
  const medianVol = medianRollingVol(logPricesA, cfg.lookbackBars);
  let vol: VolRegime = 'NORMAL';
  if (medianVol > 0) {
    if (realisedVol > cfg.volHighMult * medianVol) vol = 'HIGH';
    else if (realisedVol < cfg.volLowMult * medianVol) vol = 'LOW';
  }

  const slope = olsSlope(window);
  const totalDrift = slope * window.length;
  const trend: TrendRegime = Math.abs(totalDrift) >= cfg.trendSlopeThreshold ? 'TRENDING' : 'RANGE';

  let pValue: number | null = null;
  let decoupling = false;
  if (logPricesB && logPricesB.length >= cfg.lookbackBars) {
    const wB = logPricesB.slice(-cfg.lookbackBars);
    try {
      const coint = cointegrationTest(window, wB);
      pValue = coint.pValue;
      decoupling = pValue > cfg.decouplingPValueAlarm;
    } catch {
      pValue = null;
    }
  }

  return { vol, trend, decoupling, realisedVol, trendSlope: slope, pValue };
}

function stdLogReturns(logPrices: number[]): number {
  if (logPrices.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < logPrices.length; i++) rets.push(logPrices[i] - logPrices[i - 1]);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  let sq = 0;
  for (const r of rets) sq += (r - mean) * (r - mean);
  return Math.sqrt(sq / rets.length);
}

function medianRollingVol(logPrices: number[], lookback: number): number {
  if (logPrices.length < lookback + 1) return stdLogReturns(logPrices);
  const samples: number[] = [];
  for (let end = lookback; end <= logPrices.length; end++) {
    samples.push(stdLogReturns(logPrices.slice(end - lookback, end)));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function olsSlope(logPrices: number[]): number {
  const n = logPrices.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += logPrices[i]; sxy += i * logPrices[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}
