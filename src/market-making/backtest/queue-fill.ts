import { FillSide } from '../inventory/inventory-book';
import { OrderBook, OrderBookLevel } from '../microstructure/order-book';
import { SimpleQueueModel, QueuePosition } from './queue-model';
import {
  cumulativeBidSizeToPrice,
  cumulativeAskSizeToPrice,
  bestBidMicros,
  bestAskMicros,
} from './l2-tape';

// queue-fill — the ONE per-side, per-step FIFO fill decision, extracted from
// LobReplayHarness (lob-replay.ts) so the offline replay and the LIVE queue-aware
// fill engine (live/l2-live-fill-engine.ts) share the exact same fill rule instead
// of two copies drifting apart. The harness replays a pre-recorded tape; the live
// engine drives the same rule off snapshots arriving on a fast cadence. The rule
// they must agree on (the thing that makes a backtest honest — course A.10):
//
//   A maker order joins the BACK of its price level; `aheadUnits` = the cumulative
//   same-side size at its price AND BETTER when it joined (price-time priority —
//   l2-tape.ts). Over the interval to the next snapshot, `aggressiveVolumeUnits`
//   taker flow arrives on the OPPOSITE side. FIFO: it first consumes the queue
//   ahead of us, then fills us. filled = max(0, aggressiveVolume − aheadUnits),
//   capped at our remaining size, and only if a trade actually REACHED our price
//   (the touch gate). An order at an UNCHANGED price keeps its (decayed) queue
//   progress; a re-price cancels + rejoins at the back.
//
// This module is the pure mechanics ONLY — no InventoryBook, no attribution, no
// funding, no drawdown. The caller owns all accounting (so there is still exactly
// one P&L path, the InventoryBook/PnlAttributor — CLAUDE.md). Float-free except
// where the surrounding engine already rounds; everything here is bigint micros.

const sharedQueue = new SimpleQueueModel();

function bigMax0(x: bigint): bigint {
  return x > 0n ? x : 0n;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** A resting maker order with its tracked FIFO queue position at a fixed price. */
export interface RestingQuote {
  readonly side: FillSide;
  readonly priceMicros: bigint;
  /** Remaining (un-filled) asset size at this resting order, 6-dec units. */
  readonly sizeUnits: bigint;
  readonly pos: QueuePosition;
}

/** The aggressive (taker) flow + traded extremes over the interval ending at a book. */
export interface IntervalFlow {
  /** Taker BUYS that lifted asks over the interval, 6-dec asset units. */
  readonly aggressiveBuyUnits: bigint;
  /** Taker SELLS that hit bids over the interval, 6-dec asset units. */
  readonly aggressiveSellUnits: bigint;
  /** Highest traded price over the interval (micros) — the ask-side touch gate. */
  readonly tradedHighMicros?: bigint;
  /** Lowest traded price over the interval (micros) — the bid-side touch gate. */
  readonly tradedLowMicros?: bigint;
}

/** The outcome of settling one resting order against one step of flow. */
export interface FillOutcome {
  /** Asset units filled this step (0 = no fill). */
  readonly filledUnits: bigint;
  /** True if a trade reached our price this step (the touch — the fill-on-touch upper bound). */
  readonly touched: boolean;
  /** The order carried into the NEXT step (decayed queue + reduced size), or undefined if fully filled. */
  readonly remaining: RestingQuote | undefined;
}

/**
 * Settle one resting order against one step's aggressive flow + new book, FIFO.
 * This is the exact rule LobReplayHarness applies per side per step, factored out
 * so the live engine cannot drift from it. `book` is the snapshot observed at the
 * END of the interval (used to decay the queue from cancellations as in the
 * harness). Returns the fill quantity, whether it touched (for the upper-bound
 * counter), and the order to carry forward.
 */
export function settleRestingOrder(order: RestingQuote, book: OrderBook, flow: IntervalFlow): FillOutcome {
  if (order.side === 'BUY') {
    const aheadStart = order.pos.aheadUnits;
    // A sell traded down to/through our bid? (fall back to best-bid / just-above when no extreme given)
    const lowMicros = flow.tradedLowMicros ?? bestBidMicros(book) ?? order.priceMicros + 1n;
    const reached = order.priceMicros >= lowMicros;
    const volToUs = reached ? bigMax0(flow.aggressiveSellUnits - aheadStart) : 0n;
    const fillQty = bigMin(volToUs, order.sizeUnits);
    const lvlAfter: OrderBookLevel = {
      priceMicros: order.priceMicros,
      sizeUnits: cumulativeBidSizeToPrice(book, order.priceMicros),
      orderCount: 0,
    };
    const pos2 = sharedQueue.decay(order.pos, lvlAfter, flow.aggressiveSellUnits, book.ts);
    const remainingSize = order.sizeUnits - fillQty;
    return {
      filledUnits: fillQty,
      touched: reached,
      remaining: remainingSize > 0n ? { ...order, sizeUnits: remainingSize, pos: pos2 } : undefined,
    };
  }
  // SELL side: a buy traded up to/through our ask.
  const aheadStart = order.pos.aheadUnits;
  const highMicros = flow.tradedHighMicros ?? bestAskMicros(book) ?? order.priceMicros - 1n;
  const reached = order.priceMicros <= highMicros;
  const volToUs = reached ? bigMax0(flow.aggressiveBuyUnits - aheadStart) : 0n;
  const fillQty = bigMin(volToUs, order.sizeUnits);
  const lvlAfter: OrderBookLevel = {
    priceMicros: order.priceMicros,
    sizeUnits: cumulativeAskSizeToPrice(book, order.priceMicros),
    orderCount: 0,
  };
  const pos2 = sharedQueue.decay(order.pos, lvlAfter, flow.aggressiveBuyUnits, book.ts);
  const remainingSize = order.sizeUnits - fillQty;
  return {
    filledUnits: fillQty,
    touched: reached,
    remaining: remainingSize > 0n ? { ...order, sizeUnits: remainingSize, pos: pos2 } : undefined,
  };
}

/**
 * F2 requote hysteresis + dwell (Journal #61) — the quote anti-churn decision, SHARED by the
 * live engine and the replay harness so the offline A/B validates the exact live logic.
 *
 * The chatter problem: a micro-price quote center moves a hair every tick, so the desired
 * price almost never EXACTLY equals the resting price ⇒ the engine cancel/replaces every
 * cycle, rejoining the BACK of the FIFO queue each time (and re-arming the latency rail).
 * Holding through sub-threshold drift keeps the queue position — the front of the queue is
 * where the maker fills happen.
 *
 * Rules (drift = |desired − resting| in bps of mid):
 *  - drift ≥ urgentBps  ⇒ MOVE (a real move; holding here is the stale-quote pick-off of #27)
 *  - drift <  minBps    ⇒ HOLD ('hysteresis' — noise)
 *  - else               ⇒ HOLD while the quote is younger than dwellMs ('dwell'), MOVE after
 */
export interface RequoteHysteresisCfg {
  /** Drift below this never moves the quote (hysteresis floor), bps of mid. */
  minBps: number;
  /** Minimum quote lifetime before a mid-band drift may move it, ms. */
  dwellMs: number;
  /** Drift at/above this always moves (bypasses dwell) — the arm/disarm split. */
  urgentBps: number;
}

export type RequoteHold = 'hysteresis' | 'dwell' | null;

export function decideRequote(
  current: RestingQuote | undefined,
  desiredMicros: bigint,
  midMicros: bigint,
  placedAtMs: number | undefined,
  nowMs: number,
  cfg: RequoteHysteresisCfg | undefined,
): { priceMicros: bigint; held: RequoteHold } {
  if (!current || !cfg || cfg.minBps <= 0 || midMicros <= 0n || current.priceMicros === desiredMicros) {
    return { priceMicros: desiredMicros, held: null };
  }
  const drift = desiredMicros > current.priceMicros ? desiredMicros - current.priceMicros : current.priceMicros - desiredMicros;
  const driftBps = (Number(drift) / Number(midMicros)) * 1e4;
  if (driftBps >= cfg.urgentBps) return { priceMicros: desiredMicros, held: null };
  if (driftBps < cfg.minBps) return { priceMicros: current.priceMicros, held: 'hysteresis' };
  const ageMs = placedAtMs !== undefined ? nowMs - placedAtMs : Infinity;
  if (ageMs < cfg.dwellMs) return { priceMicros: current.priceMicros, held: 'dwell' };
  return { priceMicros: desiredMicros, held: null };
}

/**
 * Place or persist a resting order at a price (post-only). Mirrors LobReplayHarness.place:
 * a quote that would cross the opposite best is REJECTED (post-only); the SAME price keeps
 * its queue position + remaining size; a NEW price rejoins the back of the queue with the
 * cumulative same-side-and-better size ahead of it. Returns the resting order (or undefined
 * when post-only-rejected) plus the size that was ahead at a fresh placement (for the
 * avg-queue-depth stat / the placement callback). `current` is the order resting before
 * this re-quote (undefined when none).
 */
export interface PlacementResult {
  readonly order: RestingQuote | undefined;
  /** Size resting ahead at a NEW placement; undefined when the price was held (no rejoin). */
  readonly aheadUnitsAtPlacement: bigint | undefined;
}

export function placeRestingOrder(
  current: RestingQuote | undefined,
  side: FillSide,
  priceMicros: bigint,
  sizeUnits: bigint,
  book: OrderBook,
): PlacementResult {
  // Post-only: a maker quote that would cross the opposite best is rejected.
  if (side === 'BUY') {
    const ba = bestAskMicros(book);
    if (ba !== undefined && priceMicros >= ba) return { order: undefined, aheadUnitsAtPlacement: undefined };
  } else {
    const bb = bestBidMicros(book);
    if (bb !== undefined && priceMicros <= bb) return { order: undefined, aheadUnitsAtPlacement: undefined };
  }
  if (current && current.priceMicros === priceMicros) {
    // Hold our price: retain queue position + remaining size (no rejoin).
    return { order: current, aheadUnitsAtPlacement: undefined };
  }
  // New price level: join the back of the queue. Price-time priority ⇒ everything
  // resting at OUR price and better is ahead of us (cumulative, not just our level).
  const aheadThere = side === 'BUY' ? cumulativeBidSizeToPrice(book, priceMicros) : cumulativeAskSizeToPrice(book, priceMicros);
  const level: OrderBookLevel = { priceMicros, sizeUnits: aheadThere, orderCount: 0 };
  const pos = sharedQueue.enqueue(level, sizeUnits, book.ts);
  return { order: { side, priceMicros, sizeUnits, pos }, aheadUnitsAtPlacement: pos.aheadUnits };
}
