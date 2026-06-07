import { L2Snapshot } from '../../market-data/reference/reference-source.interface';
import { OrderBook } from './order-book';
import { MicroPriceCalculator } from './micro-price';

// microPriceMicrosFromL2 — the live quote CENTER (fair value), bridging an L2 depth
// snapshot to the size-weighted micro-price the LOB-replay validated (F1, the single
// biggest adverse-selection cut — FAIR_VALUE_AND_THESIS_DESIGN.md §Layer A). A naive
// maker quotes off the stale last-trade mid and gets picked off; centering on the
// book-imbalance micro-price quotes where price is *about to be*, not where it was.
//
// L2Snapshot is a structural copy of microstructure/OrderBook (both are levels of
// {priceMicros, sizeUnits, orderCount} — kept decoupled per CLAUDE.md §6), so we
// adapt it in one line and reuse the same MicroPriceCalculator the backtest uses —
// the live center is computed identically to the validated replay.

/** Micro-price (price-micros) from an L2 snapshot, or null when a side is empty. */
export function microPriceMicrosFromL2(snap: L2Snapshot, depth: number): bigint | null {
  const ob: OrderBook = { symbol: snap.symbol, ts: snap.ts, bids: snap.bids, asks: snap.asks };
  const mp = new MicroPriceCalculator({ depth: Math.max(1, depth) }).compute(ob);
  return mp === undefined || !Number.isFinite(mp) ? null : BigInt(Math.round(mp));
}
