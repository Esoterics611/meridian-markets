import { LobReplayHarness, LobReplayConfig } from './lob-replay';
import { L2TapeStep } from './l2-tape';
import { OrderBook, OrderBookLevel } from '../microstructure/order-book';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from '../quote/quote-pair';

// --- helpers ---------------------------------------------------------------
const px = (n: number): bigint => BigInt(Math.round(n * 1_000_000)); // price → micros
const u = (n: number): bigint => BigInt(Math.round(n * 1_000_000)); // size → 6-dec units

function lvl(priceMicros: bigint, sizeUnits: bigint): OrderBookLevel {
  return { priceMicros, sizeUnits, orderCount: 1 };
}

function book(bestBidPx: number, bestBidSz: number, bestAskPx: number, bestAskSz: number): OrderBook {
  return {
    symbol: 'BTC',
    ts: new Date(0),
    bids: [lvl(px(bestBidPx), u(bestBidSz))],
    asks: [lvl(px(bestAskPx), u(bestAskSz))],
  };
}

function bookMulti(bids: [number, number][], asks: [number, number][]): OrderBook {
  return {
    symbol: 'BTC',
    ts: new Date(0),
    bids: bids.map(([p, s]) => lvl(px(p), u(s))),
    asks: asks.map(([p, s]) => lvl(px(p), u(s))),
  };
}

function step(ob: OrderBook, aggSell: number, aggBuy: number, low: number, high: number): L2TapeStep {
  return {
    book: ob,
    aggressiveSellUnits: u(aggSell),
    aggressiveBuyUnits: u(aggBuy),
    tradedLowMicros: px(low),
    tradedHighMicros: px(high),
  };
}

// A quoter that ignores the context and always quotes a fixed bid/ask — the
// harness mechanics (queue, fills, attribution) are what's under test, not the
// quoting policy. reservation ± half ⇒ bid = reservation − half, ask = +half.
class FixedQuoter implements IQuoter {
  readonly familyId = 'fixed-test';
  constructor(private readonly reservationMicros: bigint, private readonly halfMicros: bigint, private readonly sizeUnits: bigint) {}
  quote(ctx: QuoteContext, symbol: string): QuotePair {
    return buildQuotePair({
      symbol,
      reservationMicros: this.reservationMicros,
      halfSpreadMicros: this.halfMicros,
      sizeUnits: this.sizeUnits,
      ctx,
      strategyId: 'fixed',
      tickSeq: 0,
      clock: () => new Date(0),
    });
  }
}

const QUOTE = u(1); // 1 asset unit / side
function baseCfg(tape: L2TapeStep[], makerFeeBps = 0): LobReplayConfig {
  return {
    tape,
    quoter: new FixedQuoter(px(100), px(1), QUOTE), // bid 99, ask 101
    quoteSizeUnits: QUOTE,
    gamma: 0,
    kappa: 1,
    horizonBars: 1,
    volWindowBars: 2, // ready after 3 snapshots
    volFloor: 0.0001,
    makerFeeBps,
    capitalUnits: u(1_000_000),
    symbol: 'BTC',
  };
}

// Both tapes: 8 identical steps, a 1-unit sell hitting our bid (99) each step,
// no buys reaching our ask (tradedHigh 100 < ask 101). The ONLY difference is
// the queue depth at our bid price level.
const LEN = 8;
function frontTape(): L2TapeStep[] {
  // best bid 98 (we IMPROVE to 99 → alone at the front, ahead = 0), best ask 102.
  return Array.from({ length: LEN }, () => step(book(98, 10, 102, 10), 1, 0, 99, 100));
}
function deepTape(): L2TapeStep[] {
  // best bid 99 with 100 units resting (we JOIN behind → ahead = 100), best ask 102.
  return Array.from({ length: LEN }, () => step(book(99, 100, 102, 10), 1, 0, 99, 100));
}

describe('LobReplayHarness — queue-aware vs fill-on-touch', () => {
  it('front of queue (ahead=0) fills on touch; deep queue (ahead≫vol) does not — same touches', () => {
    const front = new LobReplayHarness().run(baseCfg(frontTape()));
    const deep = new LobReplayHarness().run(baseCfg(deepTape()));

    // Identical tapes for the touch model: same number of reached steps.
    expect(front.touchFills).toBeGreaterThan(0);
    expect(deep.touchFills).toBe(front.touchFills);

    // The honest correction: front of queue fills every touch; deep queue none.
    expect(front.queueFills).toBeGreaterThan(0);
    expect(front.fillRatio).toBe(1);
    expect(deep.queueFills).toBe(0);
    expect(deep.fillRatio).toBe(0);

    // The deep book had a real queue ahead of us (averaged across bid+ask
    // placements, the ask improving to ahead=0); the improving book had none.
    expect(deep.avgQueueAheadUnits).toBeGreaterThan(front.avgQueueAheadUnits);
    expect(front.avgQueueAheadUnits).toBe(0n);
  });

  it('a deep queue eventually clears with enough aggressive volume (queue advances)', () => {
    // 12 steps, each consuming 20 units of the 100 ahead → drains to 0 (~5 steps),
    // then the next aggressive sell reaches us and fills.
    const tape = Array.from({ length: 12 }, () => step(book(99, 100, 102, 10), 20, 0, 99, 100));
    const r = new LobReplayHarness().run(baseCfg(tape));
    expect(r.queueFills).toBeGreaterThan(0); // the queue drained and we got through
    expect(r.queueFills).toBeLessThan(r.touchFills); // but still fewer than fill-on-touch
  });
});

describe('LobReplayHarness — price-time priority across levels', () => {
  // Quoter bids at 99 (reservation 100 − half 1). The book has bids at 100 and 99,
  // so our bid sits BELOW best: the queue ahead is the CUMULATIVE size at 100+99,
  // not just our own level — a sweep must consume the better-priced level first.
  const multi = (aggSell: number): L2TapeStep[] =>
    Array.from({ length: 8 }, () => step(bookMulti([[100, 5], [99, 5]], [[102, 5]]), aggSell, 0, 99, 100));

  it('suppresses a below-best quote until the cumulative queue above it clears', () => {
    const thin = new LobReplayHarness().run(baseCfg(multi(2))); // 2 units/step vs 10 ahead → never clears
    expect(thin.touchFills).toBeGreaterThan(0); // price reaches our bid (low 99)
    expect(thin.queueFills).toBe(0); // but the 10 units at 100+99 are never consumed
    // Cumulative queue faced (averaged over bid placement ahead=10 and ask ahead=0) is > 0.
    expect(thin.avgQueueAheadUnits).toBeGreaterThan(0n);

    const heavy = new LobReplayHarness().run(baseCfg(multi(30))); // 30 units/step sweeps through
    expect(heavy.queueFills).toBeGreaterThan(0); // the whole stack above us clears → we fill
  });
});

describe('LobReplayHarness — P&L attribution', () => {
  it('captures positive spread on bid fills and earns the maker rebate', () => {
    const r = new LobReplayHarness().run(baseCfg(frontTape(), -1)); // −1bps maker = rebate
    expect(r.bidFills).toBeGreaterThan(0);
    expect(r.askFills).toBe(0); // ask never reached
    // Bought below the book mid (99 vs 100) → spread captured > 0; flat-ish mid → small adverse.
    expect(r.attribution.spreadCapturedUnits).toBeGreaterThan(0n);
    // Maker rebate is negative fees (revenue).
    expect(r.attribution.feesUnits).toBeLessThan(0n);
    expect(r.feesUnits).toBeLessThan(0n);
  });
});

describe('LobReplayHarness — post-only', () => {
  it('does not place (or fill) a maker quote that would cross the opposite best', () => {
    // Quoter bid = 99, ask = 101, but the book is 100×100.5 → our ask (101) is fine,
    // our bid (99) is fine. Cross case: tighten the book so bid 99 ≥ best ask.
    const tape = Array.from({ length: LEN }, () => step(book(98.5, 10, 99, 10), 5, 5, 99, 99));
    const cfg = baseCfg(tape);
    // bid 99 ≥ bestAsk 99 → post-only reject; ask 101 > bestAsk 99 → rests but at 101, not reached (high=99).
    const r = new LobReplayHarness().run(cfg);
    expect(r.bidFills).toBe(0); // bid could never be placed (would cross)
  });
});
