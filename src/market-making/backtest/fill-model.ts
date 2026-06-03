// Bar-approximation passive-fill model. A resting maker quote fills when the
// bar's traded range reaches its price: the bid (we buy) fills if the bar's LOW
// trades down to/through it; the ask (we sell) fills if the bar's HIGH trades
// up to/through it. Both can fill in a single bar whose range straddles the
// quote — a clean round-trip that captured the spread.
//
// HONESTY: this is fill-on-touch. It assumes our order is at the front of the
// queue and fills the instant the price is touched, with no queue penalty. On a
// liquid book that OVERSTATES fills (course §1.6 / §6.8 — the single most common
// market-making backtest pathology). It is the right first cut on bar data,
// where we have no L2 depth or queue to model; the honest correction is the
// QueueModel + LobReplayHarness path (backtest/lob-replay.ts), now LIVE on
// Hyperliquid's no-key l2Book depth (scripts/mm-l2-session.ts) — it fills FIFO
// against real queue position instead of on touch. Read every bar-backtest number
// here as an UPPER BOUND on fill rate, not a promise; the harness is the lower-ish
// bound, and the truth is between the two.

export interface BarRange {
  high: number;
  low: number;
}

export interface PassiveFillResult {
  /** Bid was hit — we bought at the bid price. */
  bidFilled: boolean;
  /** Ask was lifted — we sold at the ask price. */
  askFilled: boolean;
}

export function passiveFills(bar: BarRange, bidMicros: bigint, askMicros: bigint): PassiveFillResult {
  const bid = Number(bidMicros) / 1_000_000;
  const ask = Number(askMicros) / 1_000_000;
  return {
    bidFilled: bar.low <= bid,
    askFilled: bar.high >= ask,
  };
}
