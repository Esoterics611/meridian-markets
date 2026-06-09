import { L2LiveFillEngine, L2LiveFillEngineConfig } from './l2-live-fill-engine';
import { LiveTick } from './l2-fill-engine-types';
import { L2Snapshot, L2Level } from '../../market-data/reference/reference-source.interface';
import { IntervalFlowLike } from '../backtest/l2-tape';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from '../quote/quote-pair';
import { FlowToxicityScaler } from '../microstructure/flow-toxicity';

// L2LiveFillEngine spec — the live, fast-cadence, queue-aware fill engine. Pure unit:
// canned L2 snapshots + scripted flow, no network, no DB, deterministic (the snapshot
// timestamps ARE the clock). The mechanics under test are the ported LobReplayHarness
// rule (shared queue-fill.ts) PLUS the two live-only additions: the cancel/replace
// latency rail (§6b free-lunch guard) and the fast-horizon adverse markout.

const px = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const u = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

function lvl(price: number, size: number): L2Level {
  return { priceMicros: px(price), sizeUnits: u(size), orderCount: 1 };
}

/** A one-level-per-side snapshot at time `tMs`. */
function snap(tMs: number, bidPx: number, bidSz: number, askPx: number, askSz: number): L2Snapshot {
  return { symbol: 'BTC', ts: new Date(tMs), bids: [lvl(bidPx, bidSz)], asks: [lvl(askPx, askSz)] };
}

/** A multi-level snapshot at time `tMs` (bids descending, asks ascending). */
function snapMulti(tMs: number, bids: [number, number][], asks: [number, number][]): L2Snapshot {
  return {
    symbol: 'BTC',
    ts: new Date(tMs),
    bids: bids.map(([p, s]) => lvl(p, s)),
    asks: asks.map(([p, s]) => lvl(p, s)),
  };
}

function flow(aggSell: number, aggBuy: number, low: number, high: number): IntervalFlowLike {
  return { aggressiveSellUnits: u(aggSell), aggressiveBuyUnits: u(aggBuy), tradedLowMicros: px(low), tradedHighMicros: px(high) };
}

// A quoter that always quotes a FIXED bid/ask around a fixed reservation — isolates the
// engine mechanics from quoting policy (same approach as the harness spec). When a
// referenceMicros (micro-price center) is supplied by the engine, it centers on THAT
// instead, so the test can prove the center moved.
class FixedQuoter implements IQuoter {
  readonly familyId = 'fixed-test';
  constructor(private readonly halfMicros: bigint, private readonly sizeUnits: bigint, private readonly fallbackCenter: bigint) {}
  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const center = ctx.referenceMicros ?? this.fallbackCenter;
    return buildQuotePair({
      symbol,
      reservationMicros: center,
      halfSpreadMicros: this.halfMicros,
      sizeUnits: this.sizeUnits,
      ctx,
      strategyId: 'fixed',
      tickSeq: 0,
      clock: () => new Date(0),
    });
  }
}

const QUOTE = u(1);

function baseCfg(over: Partial<L2LiveFillEngineConfig> = {}): L2LiveFillEngineConfig {
  return {
    symbol: 'BTC',
    quoter: new FixedQuoter(px(1), QUOTE, px(100)), // bid 99, ask 101 around center 100
    quoteSizeUnits: QUOTE,
    gamma: 0,
    kappa: 1,
    horizonBars: 1,
    volWindowBars: 2, // σ ready after 3 snapshots (RollingVolatility needs window+1)
    volFloor: 0.0001,
    makerFeeBps: 0,
    capitalUnits: u(1_000_000),
    cancelReplaceLatencyMs: 0, // most tests isolate the queue mechanics; latency test overrides
    ...over,
  };
}

/** Feed a list of ticks (snapshot + optional flow) into the engine. */
function run(cfg: L2LiveFillEngineConfig, ticks: LiveTick[]): L2LiveFillEngine {
  const eng = new L2LiveFillEngine(cfg);
  for (const t of ticks) eng.onSnapshot(t);
  return eng;
}

describe('L2LiveFillEngine — queue-aware fills on a live snapshot stream', () => {
  it('fills when the book trades through a front-of-queue resting bid', () => {
    // We IMPROVE to bid 99 (best bid is 98 ⇒ ahead = 0); a 1-unit sell prints down to 99.
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 6; i++) {
      ticks.push({ snapshot: snap(i * 1000, 98, 10, 102, 10), flow: flow(1, 0, 99, 100) });
    }
    const eng = run(baseCfg(), ticks);
    const m = eng.metrics();
    expect(m.touchFills).toBeGreaterThan(0);
    expect(m.queueFills).toBeGreaterThan(0);
    expect(m.bidFills).toBeGreaterThan(0);
    expect(m.askFills).toBe(0); // ask 101 never reached (high 100)
    expect(m.finalInventoryUnits).toBeGreaterThan(0n); // bought the sells ⇒ long
  });

  it('does NOT fill when the book never trades through the resting quote (no touch)', () => {
    // Same improving bid 99, but the traded low is 99.5 ⇒ no print reached 99.
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 6; i++) {
      ticks.push({ snapshot: snap(i * 1000, 98, 10, 102, 10), flow: flow(5, 0, 99.5, 100) });
    }
    const m = run(baseCfg(), ticks).metrics();
    expect(m.touchFills).toBe(0);
    expect(m.queueFills).toBe(0);
    expect(m.finalInventoryUnits).toBe(0n);
  });

  it('a deep queue (ahead ≫ volume) touches but does not fill — FIFO holds', () => {
    // Join behind 100 units at bid 99; 1-unit sells touch but never clear the queue.
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 6; i++) {
      ticks.push({ snapshot: snap(i * 1000, 99, 100, 102, 10), flow: flow(1, 0, 99, 100) });
    }
    const m = run(baseCfg(), ticks).metrics();
    expect(m.touchFills).toBeGreaterThan(0);
    expect(m.queueFills).toBe(0);
    expect(m.fillRatio).toBe(0);
  });

  it('queue advancement: a deep queue clears with enough aggressive volume, then fills', () => {
    // Join behind 100 at bid 99; 30 units/step drains the queue (~4 steps), then fills.
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 12; i++) {
      ticks.push({ snapshot: snap(i * 1000, 99, 100, 102, 10), flow: flow(30, 0, 99, 100) });
    }
    const m = run(baseCfg(), ticks).metrics();
    expect(m.queueFills).toBeGreaterThan(0); // the queue drained → we got through
    expect(m.queueFills).toBeLessThan(m.touchFills); // but fewer than fill-on-touch
  });
});

describe('L2LiveFillEngine — cancel/replace latency rail (the §6b free-lunch guard)', () => {
  // The book trades through our improving bid on EVERY tick. With zero latency the engine
  // fills from the first eligible tick; with a latency longer than the inter-tick gap the
  // FIRST fresh placement cannot be live in time, so at least one would-be fill is BLOCKED.
  function throughTicks(stepMs: number, n: number): LiveTick[] {
    const ticks: LiveTick[] = [];
    for (let i = 0; i < n; i++) ticks.push({ snapshot: snap(i * stepMs, 98, 10, 102, 10), flow: flow(1, 0, 99, 100) });
    return ticks;
  }

  it('zero latency: every touched front-of-queue fill goes through (the fantasy baseline)', () => {
    const m = run(baseCfg({ cancelReplaceLatencyMs: 0 }), throughTicks(1000, 6)).metrics();
    expect(m.queueFills).toBeGreaterThan(0);
    expect(m.latencyBlockedFills).toBe(0);
  });

  it('a quote that would fill INSIDE the cancel/replace window does NOT — proves no free lunch', () => {
    // Ticks 200ms apart, latency 250ms ⇒ a fresh placement (new price every other tick is
    // not the case here — price is held at 99, so the FIRST placement is the only fresh one
    // and its first settlement at the next snapshot is inside 250ms ⇒ blocked at least once).
    const zero = run(baseCfg({ cancelReplaceLatencyMs: 0 }), throughTicks(200, 6)).metrics();
    const lat = run(baseCfg({ cancelReplaceLatencyMs: 250 }), throughTicks(200, 6)).metrics();
    expect(lat.latencyBlockedFills).toBeGreaterThan(0); // at least one fill was blocked by latency
    expect(lat.queueFills).toBeLessThan(zero.queueFills); // ⇒ strictly fewer real fills
    // Touches are identical (latency does not change whether the price was reached).
    expect(lat.touchFills).toBe(zero.touchFills);
  });

  it('once the latency window has elapsed, a held quote fills normally (rail is a delay, not a block)', () => {
    // 50ms latency, ticks 1000ms apart ⇒ the first placement is live well before the next
    // snapshot, so nothing is blocked and fills proceed (the rail only bites when ticks are
    // faster than the round-trip).
    const m = run(baseCfg({ cancelReplaceLatencyMs: 50 }), throughTicks(1000, 6)).metrics();
    expect(m.latencyBlockedFills).toBe(0);
    expect(m.queueFills).toBeGreaterThan(0);
  });
});

describe('L2LiveFillEngine — micro-price centering (F1)', () => {
  it('centers the quote on the book-imbalance micro-price when microDepth is set', () => {
    // Heavily ask-imbalanced book: tiny ask size, large bid size ⇒ the thin (ask) side is
    // closer to depleting ⇒ micro-price pulls ABOVE the mid (toward the ask). The engine
    // must pass that as referenceMicros so the quoter recenters above the raw mid (100).
    const warm = [snapMulti(0, [[99, 50]], [[101, 1]]), snapMulti(1000, [[99, 50]], [[101, 1]])];
    const s2 = snapMulti(2000, [[99, 50]], [[101, 1]]); // the first WARM snapshot ⇒ quotes
    const noMicro = new L2LiveFillEngine(baseCfg({ microDepth: 0 }));
    const withMicro = new L2LiveFillEngine(baseCfg({ microDepth: 1 }));
    for (const w of warm) {
      noMicro.onSnapshot({ snapshot: w });
      withMicro.onSnapshot({ snapshot: w });
    }
    const qNo = noMicro.onSnapshot({ snapshot: s2 });
    const qMicro = withMicro.onSnapshot({ snapshot: s2 });
    expect(qNo).not.toBeNull();
    expect(qMicro).not.toBeNull();
    // Without micro-price the center is the raw mid (100); with it, the reservation is pulled
    // ABOVE the mid (toward the depleting ask) — strictly higher.
    expect(qMicro!.reservationMicros).toBeGreaterThan(qNo!.reservationMicros);
    expect(qMicro!.reservationMicros).toBeGreaterThan(px(100));
  });
});

describe('L2LiveFillEngine — adverse-selection markout at the fast horizon', () => {
  it('books adverse selection against the NEXT snapshot mid (the re-quote horizon), not a coarse bar', () => {
    // Resting orders settle against the NEXT snapshot's flow, so the fill's fair value is the
    // mid when the order was QUOTED and its markout is the mid at the FILLING snapshot — the
    // fast cadence, not a coarse 15s bar. Setup: warm σ (3 snapshots at mid 100), the order
    // resting at bid 99 (fairMid 100), then the mid FALLS to 99 on the snapshot whose sell
    // flow fills it ⇒ a long marked against a fallen mid ⇒ positive adverse loss.
    const eng = new L2LiveFillEngine(baseCfg());
    eng.onSnapshot({ snapshot: snap(0, 98, 10, 102, 10) }); // warm σ (1)
    eng.onSnapshot({ snapshot: snap(1000, 98, 10, 102, 10) }); // warm σ (2)
    eng.onSnapshot({ snapshot: snap(2000, 98, 10, 102, 10) }); // warm σ (3) ⇒ quote bid 99 (fairMid 100)
    // Next snapshot: mid has fallen to 99 (98×100), and a sell prints down to 99 ⇒ the resting
    // bid 99 fills here, marked against THIS mid (99) vs the fairMid (100) it was quoted at.
    eng.onSnapshot({ snapshot: snap(3000, 98, 10, 100, 10), flow: flow(1, 0, 98.5, 99.5) });
    const m = eng.metrics();
    expect(m.bidFills).toBeGreaterThan(0);
    // A long whose mid fell (100 → 99) ⇒ positive adverse-selection LOSS (the informed-flow tax).
    expect(m.attribution.adverseSelectionUnits).toBeGreaterThan(0n);
  });
});

describe('L2LiveFillEngine — accounting + post-only', () => {
  it('earns the maker rebate as negative fees on a rebate venue (HL −0.2bps)', () => {
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 6; i++) ticks.push({ snapshot: snap(i * 1000, 98, 10, 102, 10), flow: flow(1, 0, 99, 100) });
    const m = run(baseCfg({ makerFeeBps: -0.2 }), ticks).metrics();
    expect(m.queueFills).toBeGreaterThan(0);
    expect(m.feesUnits).toBeLessThan(0n); // negative fee = rebate revenue
    expect(m.attribution.feesUnits).toBeLessThan(0n);
  });

  it('does not place a maker quote that would cross the opposite best (post-only)', () => {
    // Tighten the book so our bid 99 ≥ best ask 99 ⇒ post-only reject; no bid fills possible.
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 4; i++) ticks.push({ snapshot: snap(i * 1000, 98.5, 10, 99, 10), flow: flow(5, 5, 99, 99) });
    const m = run(baseCfg(), ticks).metrics();
    expect(m.bidFills).toBe(0); // bid 99 would cross best ask 99 → never placed
  });
});

describe('L2LiveFillEngine — F3 toxicity instrumentation (DR-3)', () => {
  it('reports widen/tighten counts + scale when the toxicity scaler is wired', () => {
    // Two balanced ticks (τ≈0), then a one-sided sweep (τ=1 ⇒ widen vs the calm average),
    // then balanced again (τ=0 ⇒ tighten). Warmup snapshots (σ not ready) don't reach the scaler.
    const ticks: LiveTick[] = [
      { snapshot: snap(0, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) }, // warmup
      { snapshot: snap(1000, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) }, // warmup
      { snapshot: snap(2000, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) }, // calm (quoting begins)
      { snapshot: snap(3000, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) }, // calm
      { snapshot: snap(4000, 99, 10, 101, 10), flow: flow(0, 10, 99, 101) }, // one-sided sweep ⇒ widen
      { snapshot: snap(5000, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) }, // calm again ⇒ tighten
    ];
    const m = run(baseCfg({ toxicityScaler: new FlowToxicityScaler({ windowBars: 8, minScale: 0.5, maxScale: 3 }) }), ticks).metrics();
    expect(m.toxicity).toBeDefined();
    expect(m.toxicity!.widenSteps).toBeGreaterThanOrEqual(1);
    expect(m.toxicity!.tightenSteps).toBeGreaterThanOrEqual(1);
    expect(m.toxicity!.maxScale).toBeGreaterThan(1);
    expect(m.toxicity!.lastScale).toBeLessThan(1); // last tick tightened
  });

  it('toxicity is undefined when no scaler is wired (the defence is off — read it honestly)', () => {
    const ticks: LiveTick[] = [];
    for (let i = 0; i < 6; i++) ticks.push({ snapshot: snap(i * 1000, 99, 10, 101, 10), flow: flow(5, 5, 99, 101) });
    expect(run(baseCfg(), ticks).metrics().toxicity).toBeUndefined();
  });
});
