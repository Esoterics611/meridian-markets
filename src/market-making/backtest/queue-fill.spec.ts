import { settleRestingOrder, placeRestingOrder, decideRequote, RestingQuote, IntervalFlow } from './queue-fill';
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

// F2 requote hysteresis + dwell (Journal #61) — the shared quote anti-churn decision. The
// live engine and the replay harness both call this, so pinning it here pins both.
describe('decideRequote — F2 quote anti-churn', () => {
  const resting: RestingQuote = { side: 'BUY', priceMicros: px(100), sizeUnits: u(1), pos: { aheadUnits: 0n, joinedTs: new Date(0) } as unknown as RestingQuote['pos'] };
  const cfg = { minBps: 1, dwellMs: 400, urgentBps: 4 };
  const MID = px(100);

  it('is a passthrough with no resting order, no cfg, or minBps 0', () => {
    expect(decideRequote(undefined, px(101), MID, 0, 0, cfg)).toEqual({ priceMicros: px(101), held: null });
    expect(decideRequote(resting, px(101), MID, 0, 0, undefined)).toEqual({ priceMicros: px(101), held: null });
    expect(decideRequote(resting, px(101), MID, 0, 0, { ...cfg, minBps: 0 })).toEqual({ priceMicros: px(101), held: null });
  });

  it('holds sub-minBps drift (hysteresis) — the queue position is kept', () => {
    // 0.5bp drift on a $100 mid = $0.005
    const d = decideRequote(resting, px(100.005), MID, 0, 10_000, cfg);
    expect(d).toEqual({ priceMicros: px(100), held: 'hysteresis' });
  });

  it('always follows an urgent drift — holding a real move is the #27 pick-off', () => {
    // 5bp ≥ urgent 4bp, even though the quote is brand new (inside dwell)
    const d = decideRequote(resting, px(100.05), MID, 9_900, 10_000, cfg);
    expect(d).toEqual({ priceMicros: px(100.05), held: null });
  });

  it('mid-band drift: held while young (dwell), moves once the dwell elapses', () => {
    // 2bp drift: minBps 1 ≤ 2 < urgent 4
    const young = decideRequote(resting, px(100.02), MID, 9_900, 10_000, cfg); // age 100ms < 400
    expect(young).toEqual({ priceMicros: px(100), held: 'dwell' });
    const old = decideRequote(resting, px(100.02), MID, 9_000, 10_000, cfg); // age 1000ms ≥ 400
    expect(old).toEqual({ priceMicros: px(100.02), held: null });
  });

  it('same desired price is a hold-free passthrough (no counter noise)', () => {
    expect(decideRequote(resting, px(100), MID, 0, 10_000, cfg)).toEqual({ priceMicros: px(100), held: null });
  });
});
