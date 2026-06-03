import { OrderBookLevel } from '../microstructure/order-book';

// QueueModel — simulated queue position for a resting order, plus a
// fill-probability estimate from it (course §4.5, §6.4, Appendix A.5). This is
// the piece that separates an honest market-making backtest from a fantasy: a
// real venue fills in FIFO queue order, so an order at a price level is filled
// only after everything ahead of it is consumed or cancelled. A backtest that
// fills on touch (the bar runner, fill-model.ts) ignores this and overstates
// fills by an order of magnitude on a liquid book.
//
// SimpleQueueModel is the auditable baseline: join at the back of the level,
// decay the size-ahead as aggressive volume hits the level and as the level
// shrinks (cancellations), and read fill probability off a Poisson arrival
// model once we're at the front.
//
// STATUS: this model is now DRIVEN. The LobReplayHarness (backtest/lob-replay.ts,
// course A.10) replays a real L2 tape — Hyperliquid's no-key `l2Book` 20×20 depth
// (HyperliquidClient.l2Snapshot) polled live by scripts/mm-l2-session.ts — and uses
// this model for FIFO queue position, attributing fills through the existing
// PnlAttributor. The harness extends the price-time-priority idea below across
// levels (cumulative size at our price and better is ahead of us — l2-tape.ts).
// The bar runner (fill-on-touch, an upper bound) remains the OHLCV-only backtest;
// the harness is the honest, queue-aware one wherever an L2 tape exists.

export interface QueuePosition {
  readonly priceMicros: bigint;
  readonly sizeUnits: bigint;
  /** Total size resting ahead of us when we joined, minus what's since cleared. */
  readonly aheadUnits: bigint;
  readonly joinedAt: Date;
}

export interface QueueModel {
  /** Join the back of a level: everything currently resting is ahead of us. */
  enqueue(level: OrderBookLevel, sizeUnits: bigint, now: Date): QueuePosition;
  /**
   * Advance on an L2 update. `aggressiveVolumeUnits` traded through this level
   * (consumes from the front); a shrink in level size beyond that is treated as
   * cancellations ahead of us. Returns the new position.
   */
  decay(pos: QueuePosition, levelAfter: OrderBookLevel, aggressiveVolumeUnits: bigint, now: Date): QueuePosition;
  /** P(filled within horizon) given queue position and Poisson arrival intensity. */
  fillProbability(pos: QueuePosition, lambdaPerSecond: number, horizonSeconds: number): number;
}

function bigMax0(x: bigint): bigint {
  return x > 0n ? x : 0n;
}

export class SimpleQueueModel implements QueueModel {
  enqueue(level: OrderBookLevel, sizeUnits: bigint, now: Date): QueuePosition {
    return { priceMicros: level.priceMicros, sizeUnits, aheadUnits: level.sizeUnits, joinedAt: now };
  }

  decay(pos: QueuePosition, levelAfter: OrderBookLevel, aggressiveVolumeUnits: bigint, now: Date): QueuePosition {
    // Aggressive trades consume from the front of the queue, ahead of us.
    let ahead = bigMax0(pos.aheadUnits - bigMax0(aggressiveVolumeUnits));
    // Beyond what trades consumed, a drop in resting size is cancellations. We
    // can't see *where* in the queue they cancelled; the neutral assumption that
    // keeps the model honest is that cancellations are spread proportionally, so
    // the size ahead can't exceed the level's remaining size minus our own.
    const maxAhead = bigMax0(levelAfter.sizeUnits - pos.sizeUnits);
    if (ahead > maxAhead) ahead = maxAhead;
    return { ...pos, aheadUnits: ahead };
  }

  fillProbability(pos: QueuePosition, lambdaPerSecond: number, horizonSeconds: number): number {
    if (lambdaPerSecond <= 0 || horizonSeconds <= 0) return 0;
    // We're filled once cumulative arrivals exceed the size ahead of us. With a
    // Poisson(λ·t) count of unit-arrivals, P(fill) = P(N ≥ aheadUnits). We
    // approximate with the mean-arrival expectation: expected arrivals μ = λ·t,
    // and use the exponential CDF on the size-ahead as a smooth, monotone proxy
    // (0 when deep in the queue, → 1 as the queue clears) — adequate for a
    // cancel/hold decision; the LOB harness uses the exact count.
    const ahead = Number(pos.aheadUnits) / 1_000_000; // assets ahead
    const mu = lambdaPerSecond * horizonSeconds;
    if (ahead <= 0) return 1;
    return 1 - Math.exp(-mu / ahead);
  }
}
