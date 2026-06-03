import { OrderBook, OrderBookLevel, bestBid, bestAsk } from '../microstructure/order-book';
import { L2Snapshot } from '../../market-data/reference/reference-source.interface';

// L2 tape — the time-ordered sequence of depth snapshots the LobReplayHarness
// (lob-replay.ts) replays to produce queue-aware (honest) fills instead of
// fill-on-touch (course A.10). One L2TapeStep is one observed book plus the
// aggressive taker flow that arrived over the interval ending at that book.
//
// WHERE THE DATA COMES FROM. Hyperliquid's public `l2Book` POST gives a no-key
// 20×20 snapshot but NO history, so a real tape is built by POLLING it live over
// a session (scripts/mm-l2-session.ts). The aggressive volume per interval is
// not in the depth feed; the live capture estimates it from the matching candle's
// volume signed by the mid move (the tick rule) — an approximation, stated
// honestly. In unit tests the volume + traded extremes are supplied directly so
// the queue mechanics are deterministic.
//
// l2SnapshotToOrderBook is the one-line bridge from the reference module's neutral
// L2Snapshot (a deliberate structural copy — CLAUDE.md §6) to market-making's
// OrderBook. Keeping the copy means market-data never imports market-making.

export interface L2TapeStep {
  /** Depth snapshot observed at this step. */
  readonly book: OrderBook;
  /** Taker BUYS that lifted asks over the interval ending here, in asset units. */
  readonly aggressiveBuyUnits: bigint;
  /** Taker SELLS that hit bids over the interval ending here, in asset units. */
  readonly aggressiveSellUnits: bigint;
  /** Highest traded price over the interval (micros); for the ask-side touch gate. */
  readonly tradedHighMicros?: bigint;
  /** Lowest traded price over the interval (micros); for the bid-side touch gate. */
  readonly tradedLowMicros?: bigint;
}

/** Convert a reference-module L2Snapshot to a microstructure OrderBook. */
export function l2SnapshotToOrderBook(snap: L2Snapshot): OrderBook {
  const map = (l: { priceMicros: bigint; sizeUnits: bigint; orderCount: number }): OrderBookLevel => ({
    priceMicros: l.priceMicros,
    sizeUnits: l.sizeUnits,
    orderCount: l.orderCount,
  });
  return {
    symbol: snap.symbol,
    ts: snap.ts,
    bids: snap.bids.map(map),
    asks: snap.asks.map(map),
  };
}

/** Resting size at the bid-side level whose price equals `priceMicros` (0 if none). */
export function bidSizeAt(book: OrderBook, priceMicros: bigint): bigint {
  return book.bids.find((l) => l.priceMicros === priceMicros)?.sizeUnits ?? 0n;
}

/** Resting size at the ask-side level whose price equals `priceMicros` (0 if none). */
export function askSizeAt(book: OrderBook, priceMicros: bigint): bigint {
  return book.asks.find((l) => l.priceMicros === priceMicros)?.sizeUnits ?? 0n;
}

// PRICE-TIME PRIORITY across levels. A resting bid at price P is filled only after
// every bid at a BETTER (higher) price is consumed — those orders are ahead of us
// in the venue's global fill order, not just the size at our own level. So the true
// queue ahead of a maker quote is the CUMULATIVE same-side size from the top of book
// down to (and including) our price. This is what makes a quote placed below best
// fill far less than fill-on-touch assumes: aggressive flow has to sweep the whole
// stack above us first. An improving quote (inside the spread) has 0 ahead.

/** Cumulative bid size at all levels priced ≥ `priceMicros` (the queue ahead of a bid there). */
export function cumulativeBidSizeToPrice(book: OrderBook, priceMicros: bigint): bigint {
  let sum = 0n;
  for (const l of book.bids) {
    if (l.priceMicros >= priceMicros) sum += l.sizeUnits;
  }
  return sum;
}

/** Cumulative ask size at all levels priced ≤ `priceMicros` (the queue ahead of an ask there). */
export function cumulativeAskSizeToPrice(book: OrderBook, priceMicros: bigint): bigint {
  let sum = 0n;
  for (const l of book.asks) {
    if (l.priceMicros <= priceMicros) sum += l.sizeUnits;
  }
  return sum;
}

/** Best-bid price in micros (undefined on an empty side). */
export function bestBidMicros(book: OrderBook): bigint | undefined {
  return bestBid(book)?.priceMicros;
}

/** Best-ask price in micros (undefined on an empty side). */
export function bestAskMicros(book: OrderBook): bigint | undefined {
  return bestAsk(book)?.priceMicros;
}
