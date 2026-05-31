// MmSuitabilityScorer — ranks an instrument by its expected MARKET-MAKING
// profit per day: "where should we quote?" The maker's twin of the stat-arb
// net-edge scorer. You want a tight natural spread relative to the rebate, low
// toxicity, and low vol (low inventory risk):
//
//   netPerRoundTrip = grossSpread + rebate − adverse        (all bps, both legs)
//   roundTripsPerDay ≈ fillProbPerBar · barsPerDay / 2
//   scorePerDay      = netPerRoundTrip · roundTripsPerDay
//
// HONESTY: on OHLCV we have no order book and no flow tape, so two inputs are
// PROXIES — `adverseBps ≈ adverseCoef · σ_bar` (post-fill markout scales with
// volatility) and `fillProbPerBar ≈ (avgRange/2) / quoteHalfSpread` (the chance
// the bar's half-range reaches a quote one half-spread out). They rank
// instruments sensibly (a calm stablecoin with a rebate beats a volatile major)
// but are not a fill forecast; the real version needs L2 depth + a flow/markout
// tape (the same L2 ingest the LOB-replay backtest waits on). `adverseCoef` is
// the load-bearing assumption — surfaced as config so it can be calibrated.

export interface MmSuitabilityInput {
  /** Per-bar realised volatility as a fraction of price. */
  volatility: number;
  /** Mean (high−low)/close over the window, in bps — the fillable range proxy. */
  avgRangeBps: number;
  /** Maker rebate in bps (positive = revenue), 0 if the maker pays a fee. */
  rebateBps: number;
  /** Half-spread we would post, in bps of mid. */
  quoteHalfSpreadBps: number;
  barsPerDay: number;
  /** Adverse selection per fill as a multiple of one σ_bar. Default 0.5. */
  adverseCoef?: number;
}

export interface MmSuitabilityScore {
  volBps: number;
  /** Gross spread captured per round-trip (both legs), bps. */
  grossSpreadBps: number;
  /** Rebate earned per round-trip (both legs), bps. */
  rebateRoundTripBps: number;
  /** Adverse selection per round-trip (both legs), bps. */
  adverseRoundTripBps: number;
  /** Net edge per round-trip, bps. */
  netPerRoundTripBps: number;
  fillProbPerBar: number;
  roundTripsPerDay: number;
  /** Headline ranking number, bps/day. */
  scorePerDayBps: number;
  attractive: boolean;
}

export function scoreMmSuitability(input: MmSuitabilityInput): MmSuitabilityScore {
  const adverseCoef = input.adverseCoef ?? 0.5;
  const volBps = Math.max(0, input.volatility) * 10_000;

  const grossSpreadBps = 2 * Math.max(0, input.quoteHalfSpreadBps);
  const rebateRoundTripBps = 2 * Math.max(0, input.rebateBps);
  const adverseRoundTripBps = 2 * adverseCoef * volBps;
  const netPerRoundTripBps = grossSpreadBps + rebateRoundTripBps - adverseRoundTripBps;

  const fillProbPerBar = clamp01(input.avgRangeBps / 2 / Math.max(input.quoteHalfSpreadBps, 1e-9));
  const roundTripsPerDay = (fillProbPerBar * input.barsPerDay) / 2;

  const scorePerDayBps = netPerRoundTripBps * roundTripsPerDay;

  return {
    volBps,
    grossSpreadBps,
    rebateRoundTripBps,
    adverseRoundTripBps,
    netPerRoundTripBps,
    fillProbPerBar,
    roundTripsPerDay,
    scorePerDayBps,
    attractive: netPerRoundTripBps > 0 && fillProbPerBar > 0,
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
