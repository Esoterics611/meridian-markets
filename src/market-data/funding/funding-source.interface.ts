// IFundingRateSource — the seam for perpetual-swap funding-rate data, the first
// non-equity, non-spread data source on the desk (STRATEGY_LIBRARY_REWRITE.md #2).
// A perp's funding rate is the periodic cash flow longs pay shorts (positive) or
// shorts pay longs (negative) to tether the perp to spot. A delta-neutral
// cash-and-carry (long spot + short perp) HARVESTS that flow — funding is the
// signal, not a price spread, so this needs its own source contract.
//
// Same discipline as every other integration (CLAUDE.md §7): an interface with a
// real (Binance public futures REST, no key) and a mock implementation, selected
// by config. Prices are floats here to match the Bar/signal convention; money at
// the venue boundary is bigint micros.

export const FUNDING_RATE_SOURCE = Symbol('FUNDING_RATE_SOURCE');

/** One realised funding settlement (every 8h on Binance USDⓈ-M perps). */
export interface FundingPoint {
  symbol: string;
  /** Settlement time (ms epoch). */
  fundingTimeMs: number;
  /** Funding rate as a fraction of notional for this interval (e.g. 0.0001 = 1 bp / 8h). */
  fundingRate: number;
  /** Perp mark price at settlement. */
  markPrice: number;
}

/** Live funding state for sizing the next entry. */
export interface FundingSnapshot {
  symbol: string;
  lastFundingRate: number;
  nextFundingTimeMs: number;
  markPrice: number;
  indexPrice: number;
}

export interface IFundingRateSource {
  /** Realised funding settlements in [startMs, endMs), chronological. */
  fundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]>;
  /** Current funding/mark for one perp. */
  currentFunding(symbol: string): Promise<FundingSnapshot>;
}
