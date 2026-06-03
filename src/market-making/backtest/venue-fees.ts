// VenueFee — the maker/taker fee schedule for a venue, the single source of truth
// the MM backtest + tuning judge a book against. Quoting economics are decided at
// the venue's REAL maker fee, not a desk-wide flat assumption: a maker REBATE is
// revenue (negative bps), a maker COST has to be earned back on both legs before
// the book can profit. Running an HL book at Binance's fee, or vice versa, quietly
// flips the verdict — so the fee lives here, keyed by source id, not hardcoded.
//
// Signs (CLAUDE.md §3 convention, matched by InventoryBook/PnlAttributor):
//   + bps = a COST you pay; − bps = a REBATE you earn.
// Passive (post-only) maker fills pay `makerBps`; crossing the spread to flatten
// or hedge pays `takerBps`. The queue-aware replay only fills passively, so
// `makerBps` is what drives its fee column; `takerBps` is here for the flatten /
// future-hedge legs and for an honest worst-case read.

export interface VenueFee {
  /** Maker fee in bps, signed: − = rebate (revenue), + = cost. */
  readonly makerBps: number;
  /** Taker fee in bps, signed: + = cost (almost always). */
  readonly takerBps: number;
  /** Human note on where the number comes from (tier, LP fee, etc.). */
  readonly note: string;
}

// Live-verified / published schedules (the no-key paper posture; real tiers vary
// with volume — these are the conservative public defaults the desk quotes at).
const VENUE_FEES: Record<string, VenueFee> = {
  // HL: maker −0.2bps rebate / taker 2.5bps (the maker-rebate CLOB the book wants).
  hyperliquid: { makerBps: -0.2, takerBps: 2.5, note: 'HL perp CLOB: maker −0.2bps rebate / taker 2.5bps' },
  // Binance public spot, base tier: maker +1bps / taker +5bps (VIP/BNB tiers lower,
  // and a VIP maker can reach a rebate — model that explicitly via an override).
  binance: { makerBps: 1, takerBps: 5, note: 'Binance spot base tier: maker 1bps / taker 5bps' },
  // GeckoTerminal pools are AMM Uniswap-v3: the LP fee tier IS the maker cost and
  // it is POOL-DEPENDENT (1 / 5 / 30 / 100 bps). 5bps is the stable/blue-chip tier;
  // a 30bps pool must clear a much higher bar. No rebate exists on an AMM.
  geckoterminal: { makerBps: 5, takerBps: 5, note: 'AMM LP fee (pool-dependent: 1/5/30/100bps); 5bps = stable tier' },
};

const DEFAULT_FEE: VenueFee = { makerBps: 0, takerBps: 5, note: 'unknown venue: 0bps maker (structural-only) / 5bps taker' };

/** Fee schedule for a source id ('hyperliquid' | 'binance' | 'geckoterminal' | …); default = structural-only. */
export function venueFeeFor(sourceId?: string): VenueFee {
  const key = (sourceId ?? 'binance').trim().toLowerCase();
  return VENUE_FEES[key] ?? DEFAULT_FEE;
}

/** Just the maker bps for a source — the driving fee for a passive (post-only) book. */
export function makerBpsFor(sourceId?: string): number {
  return venueFeeFor(sourceId).makerBps;
}
