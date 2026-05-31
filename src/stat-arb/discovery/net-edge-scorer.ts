import { roundTripFeeFraction } from '../signal/fee-gate';

// NetEdgeScorer — ranks a discovered pair by its EXPECTED NET-OF-FEES PROFIT PER
// DAY, not by cointegration alone. This is the engine behind "scan wide, trade
// rarely": pair-discovery says *which* spreads mean-revert; this says which of
// them actually pay after the fee gate eats a thin per-trade edge, and how often.
//
//   perTradeNetEdge = (entryZ − exitZ)·σ_spread − minEdgeMultiple·roundTripFee
//   tradesPerDay    ≈ barsPerDay / (roundTripFactor · halfLifeBars)
//   certainty       = 1 − pValue                       (cointegration confidence)
//   netEdgePerDay   = perTradeNetEdge · tradesPerDay · certainty
//
// `perTradeNetEdge > 0` is exactly the fee gate (signal/fee-gate.ts) the live
// strategies enforce, so the board and the trader agree on what's tradeable.
// tradesPerDay is a proxy from the OU half-life (a reverting spread round-trips
// on a few-half-life timescale); it ranks frequency, it is not a fill forecast.

export interface NetEdgeInput {
  /** Std of the log-spread over the recent window (the per-trade edge scale). */
  sigmaSpread: number;
  halfLifeBars: number;
  /** Cointegration p-value (lower = more confident). */
  pValue: number;
  entryZ: number;
  exitZ: number;
  /** Round-trip taker fee in bps (4 legs). */
  feeBps: number;
  /** Bars per day at the feed interval (e.g. 1440 for 1m). */
  barsPerDay: number;
  /** Safety multiple on the fee floor. Default 1. */
  minEdgeMultiple?: number;
  /** Half-lives per round-trip. Default 2. */
  roundTripFactor?: number;
}

export interface NetEdgeScore {
  /** Net edge per round-trip as a fraction of per-leg notional. */
  perTradeNetEdgeFrac: number;
  perTradeNetEdgeBps: number;
  tradesPerDay: number;
  certainty: number;
  /** The headline ranking number, in bps/day. */
  netEdgePerDayBps: number;
  /** True iff the trade clears the fee gate (perTradeNetEdge > 0). */
  clearsFees: boolean;
}

export function scoreNetEdge(input: NetEdgeInput): NetEdgeScore {
  const mult = input.minEdgeMultiple ?? 1;
  const factor = input.roundTripFactor ?? 2;

  const grossEdgeFrac = Math.max(0, input.entryZ - input.exitZ) * Math.max(0, input.sigmaSpread);
  const feeCostFrac = roundTripFeeFraction(input.feeBps) * Math.max(mult, 0);
  const perTradeNetEdgeFrac = grossEdgeFrac - feeCostFrac;

  const roundTripBars = Math.max(1, factor * input.halfLifeBars);
  const tradesPerDay = input.barsPerDay / roundTripBars;
  const certainty = clamp01(1 - input.pValue);

  const perTradeNetEdgeBps = perTradeNetEdgeFrac * 10_000;
  // Only credit positive expectancy; a sub-fee pair scores 0/day, not negative.
  const netEdgePerDayBps = Math.max(0, perTradeNetEdgeBps) * tradesPerDay * certainty;

  return {
    perTradeNetEdgeFrac,
    perTradeNetEdgeBps,
    tradesPerDay,
    certainty,
    netEdgePerDayBps,
    clearsFees: perTradeNetEdgeFrac > 0,
  };
}

/** Bars per day for a Binance kline interval string (1m, 5m, 1h, 1d, ...). */
export function barsPerDayForInterval(interval: string): number {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim());
  if (!m) return 1440; // default to 1m
  const n = Number(m[1]);
  const unitMinutes = { m: 1, h: 60, d: 1440, w: 10080 }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return Math.max(1, 1440 / (n * unitMinutes));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
