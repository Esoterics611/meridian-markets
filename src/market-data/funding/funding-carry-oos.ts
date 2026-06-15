import { FundingPoint } from './funding-source.interface';
import { staticCarry, CarryInputs } from './funding-carry';
import { CarryDirection } from './funding-carry-discovery';

// Funding-carry OOS persistence gate — the honesty gate for T2 (PROFIT_PIVOT.md §5).
//
// The single-window posFrac used in funding-carry-discovery is an IN-SAMPLE read.
// A funding stream can look one-signed in one window and flip in the next (funding
// follows regime, not a law). The gate enforces stability OUT OF SAMPLE:
//
//   Split the funding history at trainFraction (default 2/3) by time.
//   Score posFrac independently in each window via staticCarry.
//   A symbol passes only when BOTH windows show stable posFrac (≥ minPosFrac),
//   confirming the carry direction is persistent, not a single-window artefact.
//
// This is the carry analogue of the cointegration-persistence gate (#5 discipline):
// measure OOS, harvest only the stable.

export interface OosGateConfig {
  /** Fraction of history used as training window (default 2/3). */
  trainFraction?: number;
  /** Both in-sample and OOS posFrac must clear this (default 0.65). */
  minPosFrac?: number;
  /** Venue-specific: periods per year for annualisation. */
  periodsPerYear: number;
  spotFeeBps: number;
  perpFeeBps: number;
  notionalUnits: bigint;
}

export interface OosFundingResult {
  symbol: string;
  direction: CarryDirection;
  /** In-sample window (train). */
  inSample: {
    periods: number;
    windowDays: number;
    posFrac: number;
    annualizedFundingPct: number;
    annualizedNetPct: number;
  };
  /** Out-of-sample window. */
  oos: {
    periods: number;
    windowDays: number;
    posFrac: number;
    annualizedFundingPct: number;
    annualizedNetPct: number;
  };
  /** Combined stats on the full window (for sizing/display). */
  full: {
    periods: number;
    windowDays: number;
    annualizedFundingPct: number;
    annualizedNetPct: number;
    breakevenDays: number;
  };
  /** True when both windows are stable in the same direction. */
  passGate: boolean;
}

/**
 * Run the OOS persistence gate on a single symbol's funding history.
 * Returns null when there are too few settlements to split meaningfully (< 6).
 */
export function oosCarryGate(symbol: string, allFunding: FundingPoint[], cfg: OosGateConfig): OosFundingResult | null {
  if (allFunding.length < 6) return null;

  const sorted = [...allFunding].sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  const trainFrac = cfg.trainFraction ?? 2 / 3;
  const minPosFrac = cfg.minPosFrac ?? 0.65;

  const splitIdx = Math.max(3, Math.floor(sorted.length * trainFrac));
  const trainData = sorted.slice(0, splitIdx);
  const oosData = sorted.slice(splitIdx);

  if (oosData.length < 3) return null;

  const baseInputs: Omit<CarryInputs, 'funding'> = {
    spotEntry: 1,
    spotExit: 1,
    perpEntry: 1,
    perpExit: 1,
    notionalUnits: cfg.notionalUnits,
    spotFeeBps: cfg.spotFeeBps,
    perpFeeBps: cfg.perpFeeBps,
    periodsPerYear: cfg.periodsPerYear,
  };

  const trainRes = staticCarry({ ...baseInputs, funding: trainData });
  const oosRes = staticCarry({ ...baseInputs, funding: oosData });
  const fullRes = staticCarry({ ...baseInputs, funding: sorted });

  // Direction from the full window (most stable estimate).
  const direction: CarryDirection = fullRes.meanFundingPerPeriod >= 0 ? 'SHORT_PERP' : 'LONG_PERP';

  // OOS posFrac may refer to either direction: when direction is LONG_PERP we harvest
  // NEGATIVE funding, so stability means the negFrac is high, i.e. posFrac is LOW.
  const trainStable = direction === 'SHORT_PERP' ? trainRes.positiveFraction >= minPosFrac : (1 - trainRes.positiveFraction) >= minPosFrac;
  const oosStable = direction === 'SHORT_PERP' ? oosRes.positiveFraction >= minPosFrac : (1 - oosRes.positiveFraction) >= minPosFrac;
  const passGate = trainStable && oosStable;

  // Breakeven: round-trip fee / daily funding (in rate units).
  const roundTripFee = (2 * (cfg.spotFeeBps + cfg.perpFeeBps)) / 10_000;
  const periodsPerDay = cfg.periodsPerYear / 365;
  const meanRate = Math.abs(fullRes.meanFundingPerPeriod);
  const breakevenDays = meanRate > 0 ? roundTripFee / (meanRate * periodsPerDay) : Infinity;

  return {
    symbol,
    direction,
    inSample: {
      periods: trainRes.periods,
      windowDays: trainRes.windowDays,
      posFrac: trainRes.positiveFraction,
      annualizedFundingPct: direction === 'SHORT_PERP' ? trainRes.annualizedFundingPct : -trainRes.annualizedFundingPct,
      annualizedNetPct: trainRes.annualizedNetPct,
    },
    oos: {
      periods: oosRes.periods,
      windowDays: oosRes.windowDays,
      posFrac: oosRes.positiveFraction,
      annualizedFundingPct: direction === 'SHORT_PERP' ? oosRes.annualizedFundingPct : -oosRes.annualizedFundingPct,
      annualizedNetPct: oosRes.annualizedNetPct,
    },
    full: {
      periods: fullRes.periods,
      windowDays: fullRes.windowDays,
      annualizedFundingPct: direction === 'SHORT_PERP' ? fullRes.annualizedFundingPct : -fullRes.annualizedFundingPct,
      annualizedNetPct: fullRes.annualizedNetPct,
      breakevenDays,
    },
    passGate,
  };
}

/** Score an array of symbols and return the results sorted by full annualizedFundingPct (desc). */
export function rankCarryUniverse(
  histories: { symbol: string; funding: FundingPoint[] }[],
  cfg: OosGateConfig,
): OosFundingResult[] {
  const results: OosFundingResult[] = [];
  for (const { symbol, funding } of histories) {
    const r = oosCarryGate(symbol, funding, cfg);
    if (r) results.push(r);
  }
  return results.sort((a, b) => b.full.annualizedFundingPct - a.full.annualizedFundingPct);
}
