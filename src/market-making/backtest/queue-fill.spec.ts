import { settleRestingOrder, placeRestingOrder, RestingQuote, IntervalFlow } from './queue-fill';
import { OrderBook, OrderBookLevel } from '../microstructure/order-book';

// queue-fill spec — the shared, pure per-side FIFO fill + placement rule extracted from
// LobReplayHarness so the replay and the live engine cannot drift. Tested directly here
// (the harness + live-engine specs exercise it end-to-end); this pins the primitive.

const px = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const u = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

function lvl(price: number, size: number): OrderBookLevel {
  return { priceMicros: px(price), sizeUnits: u(size), orderCount: 1 };
}
function book(bids: [number, number][], asks: [number, number][]): OrderBook {
  return { symbol: 'BTC', ts: new Date(0), bids: bids.map(([p, s]) => lvl(p, s)), asks: asks.map(([p, s]) => lvl(p, s)) };
}
function flow(aggSell: number, aggBuy: number, low: number, high: number): IntervalFlow {
  return { aggressiveSellUnits: u(aggSell), aggressiveBuyUnits: u(aggBuy), tradedLowMicros: px(low), tradedHighMicros: px(high) };
}

describe('placeRestingOrder — post-only + price-time priority', () => {
  it('improving inside the spread joins with ahead = 0', () => {
    const ob = book([[98, 10]], [[102, 10]]);
    const res = placeRestingOrder(undefined, 'BUY', px(99), u(1), ob);
    expect(res.order).toBeDefined();
    expect(res.aheadUnitsAtPlacement).toBe(0n); // nothing resting at 99 or better
  });

  it('joining behind resting size sees the cumulative same-side-and-better queue ahead', () => {
    const ob = book([[100, 5], [99, 5]], [[102, 5]]);
    const res = placeRestingOrder(undefined, 'BUY', px(99), u(1), ob);
    expect(res.aheadUnitsAtPlacement).toBe(u(10)); // 5 @ 100 + 5 @ 99
  });

  it('holding the same price keeps the existing order (no rejoin)', () => {
    const ob = book([[98, 10]], [[102, 10]]);
    const first = placeRestingOrder(undefined, 'BUY', px(99), u(1), ob).order!;
    const held = placeRestingOrder(first, 'BUY', px(99), u(1), ob);
    expect(held.order).toBe(first); // same reference ⇒ queue progress retained
    expect(held.aheadUnitsAtPlacement).toBeUndefined(); // no fresh placement
  });

  it('rejects a post-only quote that would cross the opposite best', () => {
    const ob = book([[98.5, 10]], [[99, 10]]);
    const res = placeRestingOrder(undefined, 'BUY', px(99), u(1), ob); // bid 99 ≥ best ask 99
    expect(res.order).toBeUndefined();
  });
});

describe('settleRestingOrder — FIFO fill against aggressive flow', () => {
  function rest(side: 'BUY' | 'SELL', price: number, size: number, ahead: number): RestingQuote {
    return { side, priceMicros: px(price), sizeUnits: u(size), pos: { priceMicros: px(price), sizeUnits: u(size), aheadUnits: u(ahead), joinedAt: new Date(0) } };
  }

  it('fills a front-of-queue bid when a sell prints through it', () => {
    const ob = book([[98, 10]], [[102, 10]]);
    const out = settleRestingOrder(rest('BUY', 99, 1, 0), ob, flow(1, 0, 99, 100));
    expect(out.touched).toBe(true);
    expect(out.filledUnits).toBe(u(1));
    expect(out.remaining).toBeUndefined(); // fully filled
  });

  it('does not fill when the queue ahead exceeds the aggressive volume', () => {
    const ob = book([[99, 100]], [[102, 10]]);
    const out = settleRestingOrder(rest('BUY', 99, 1, 100), ob, flow(1, 0, 99, 100));
    expect(out.touched).toBe(true); // price reached
    expect(out.filledUnits).toBe(0n); // but 1 unit < 100 ahead
    expect(out.remaining).toBeDefined();
  });

  it('does not fill (or touch) when no trade reaches the price', () => {
    const ob = book([[98, 10]], [[102, 10]]);
    const out = settleRestingOrder(rest('BUY', 99, 1, 0), ob, flow(5, 0, 99.5, 100)); // low 99.5 > bid 99
    expect(out.touched).toBe(false);
    expect(out.filledUnits).toBe(0n);
  });

  it('fills an ask symmetrically when a buy prints up through it', () => {
    const ob = book([[98, 10]], [[102, 10]]);
    const out = settleRestingOrder(rest('SELL', 101, 1, 0), ob, flow(0, 1, 100, 101));
    expect(out.touched).toBe(true);
    expect(out.filledUnits).toBe(u(1));
  });
});
