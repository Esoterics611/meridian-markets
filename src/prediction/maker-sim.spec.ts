import {
  DEFAULT_MAKER_SIM,
  hedgeNotionalPerContract,
  MakerSimConfig,
  runGrid,
  simulateMaker,
  widthFloor,
} from './maker-sim';
import { TapeLevel, TapeSnap } from './maker-tape.types';

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const EXPIRY = 100 * 3_600_000; // 100h into the sim clock — far from the no-quote window

function snap(
  ms: number,
  fairYes: number,
  bids: TapeLevel[],
  asks: TapeLevel[],
  over: Partial<TapeSnap> = {},
): TapeSnap {
  return {
    ev: 'SNAP',
    ms,
    marketId: 'm1',
    underlying: 'BTC',
    targetPrice: 60_000,
    expiryMs: EXPIRY,
    fairYes,
    naive: fairYes,
    d2: 0,
    tYears: (EXPIRY - ms) / YEAR_MS,
    iv: 0.5,
    hlMid: 60_000,
    noMid: 1 - fairYes,
    smileAgeMs: 0,
    bids,
    asks,
    ...over,
  };
}

/** Frictionless base config: fees/hedge/floor off so each test enables one mechanism. */
const BASE: MakerSimConfig = {
  ...DEFAULT_MAKER_SIM,
  halfWidthProb: 0.01,
  repriceMs: 1_000,
  quoteContracts: 100,
  maxInventory: 1_000,
  floorMult: 0,
  noQuoteMinutes: 30,
  makerCloseFeeBps: 0,
  settleFeeBps: 0,
  hedgeCostBps: 0,
  markoutMs: 1_000,
};

describe('maker-sim', () => {
  it('never fills without a strict trade-through (touch ≠ fill)', () => {
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      // Ask comes down EXACTLY to our bid (0.49) — touching is not a fill.
      snap(1_000, 0.5, [[0.48, 500]], [[0.49, 500]]),
      snap(2_000, 0.5, [[0.48, 500]], [[0.52, 500]]),
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.fills).toHaveLength(0);
    expect(r.net).toBe(0);
  });

  it('captures the spread on a round-trip and charges the close fee on the closing fill only', () => {
    const cfg = { ...BASE, makerCloseFeeBps: 4 };
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]), // quotes rest at 0.49 / 0.51
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 50]]), // ask prints through our bid → BUY 50 @0.49
      snap(2_000, 0.5, [[0.515, 50]], [[0.52, 500]]), // bid prints through our ask → SELL 50 @0.51
    ];
    const r = simulateMaker(snaps, null, cfg);
    expect(r.buyFills).toBe(1);
    expect(r.sellFills).toBe(1);
    expect(r.realizedTrading).toBeCloseTo((0.51 - 0.49) * 50, 10); // $1.00 captured
    expect(r.closeFees).toBeCloseTo((4 / 10_000) * 0.51 * 50, 10); // closing side only
    expect(r.endInventory).toBe(0);
    expect(r.net).toBeCloseTo(1 - 0.0102, 10);
  });

  it('fill size is capped by displayed size at/inside our price', () => {
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 30]]), // only 30 displayed through us
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].contracts).toBe(30);
  });

  it('slow re-quote cadence eats the adverse fill that fast cadence dodges (the #27–#33 thesis)', () => {
    // Fair drifts down over two snaps; the drift never trades through a FRESH quote.
    const drift = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]), // quotes 0.49 / 0.51
      snap(1_000, 0.492, [[0.485, 500]], [[0.495, 500]]), // no through (0.495 > 0.49)
      snap(2_000, 0.48, [[0.474, 500]], [[0.483, 200]]), // through a STALE 0.49 bid only
    ];
    const fast = simulateMaker(drift, null, { ...BASE, repriceMs: 1_000 });
    expect(fast.fills).toHaveLength(0); // re-centered to 0.482 at t=1s — never run over
    const slow = simulateMaker(drift, null, { ...BASE, repriceMs: 10_000 });
    expect(slow.buyFills).toBe(1);
    expect(slow.fills[0].px).toBeCloseTo(0.49, 10); // stale bid, filled above fair 0.48
    expect(slow.fills[0].fairAtFill).toBeCloseTo(0.48, 10);
  });

  it('records adverse markout against fair at +markoutMs', () => {
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 100]]), // BUY 100 @0.49
      snap(2_000, 0.45, [[0.44, 500]], [[0.46, 500]]), // fair now 0.45
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.markoutKnown).toBe(1);
    expect(r.markoutTotal).toBeCloseTo((0.45 - 0.49) * 100, 10); // −$4 adverse
  });

  it('pulls all quotes inside the no-quote expiry window', () => {
    const nearExpiry = EXPIRY - 20 * 60_000; // 20min out < 30min window
    const snaps = [
      snap(nearExpiry, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(nearExpiry + 1_000, 0.5, [[0.48, 500]], [[0.4, 500]]), // would be a huge through
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.quotedSnaps).toBe(0);
    expect(r.fills).toHaveLength(0);
  });

  it('withholds the increasing side at the inventory cap, keeps the reducing side', () => {
    const cfg = { ...BASE, maxInventory: 50 };
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 80]]), // BUY capped… by displayed 80 > Q? no: Q=100 → 80
      snap(2_000, 0.5, [[0.48, 500]], [[0.52, 500]]), // reprice: pos=80 ≥ cap → bid OFF
      snap(3_000, 0.5, [[0.48, 500]], [[0.44, 500]]), // deep through — must NOT fill a bid
      snap(4_000, 0.5, [[0.515, 80]], [[0.52, 500]]), // …but the reducing ask still fills
    ];
    const r = simulateMaker(snaps, null, cfg);
    expect(r.buyFills).toBe(1);
    expect(r.sellFills).toBe(1);
    expect(r.endInventory).toBe(0);
  });

  it('post-only: a quote that would cross the touch is withheld for the cycle', () => {
    // Fair 0.60 sits above the book's ask 0.55 → our 0.59 bid would cross: withheld.
    const snaps = [
      snap(0, 0.6, [[0.5, 500]], [[0.55, 500]]),
      snap(1_000, 0.6, [[0.5, 500]], [[0.51, 500]]), // ask drops through where our bid WOULD have been
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.buyFills).toBe(0); // no bid ever rested
  });

  it('settles the residual position at 0/1 with the settle fee', () => {
    const cfg = { ...BASE, settleFeeBps: 4 };
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 100]]), // BUY 100 @0.49
    ];
    const r = simulateMaker(snaps, true, cfg); // settles YES
    expect(r.realizedSettle).toBeCloseTo((1 - 0.49) * 100, 10);
    expect(r.settleFees).toBeCloseTo((4 / 10_000) * 100, 10);
    expect(r.endInventory).toBe(0);
    const rNo = simulateMaker(snaps, false, cfg); // settles NO — full collateral loss
    expect(rNo.realizedSettle).toBeCloseTo((0 - 0.49) * 100, 10);
  });

  it('marks an unsettled end-of-tape position to last fair as unrealizedEnd (not net)', () => {
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 100]]), // BUY 100 @0.49
      // Fair drifts up but the book never trades through the re-quoted ask.
      snap(2_000, 0.53, [[0.505, 500]], [[0.56, 500]]),
    ];
    const r = simulateMaker(snaps, null, BASE);
    expect(r.endInventory).toBe(100);
    expect(r.unrealizedEnd).toBeCloseTo((0.53 - 0.49) * 100, 10);
    expect(r.net).toBe(0); // realized-first: unrealized never counts in net
  });

  it('charges hedge cost on fill and settle-unwind notional', () => {
    const cfg = { ...BASE, hedgeCostBps: 5 };
    const snaps = [
      snap(0, 0.5, [[0.48, 500]], [[0.52, 500]]),
      snap(1_000, 0.5, [[0.48, 500]], [[0.485, 100]], { d2: 0, iv: 0.5 }),
    ];
    const r = simulateMaker(snaps, true, cfg);
    const perContract = hedgeNotionalPerContract(0, 0.5, snaps[1].tYears);
    expect(perContract).toBeGreaterThan(0);
    // Charged twice: once at fill, once unwinding at settle (same d2/iv here).
    expect(r.hedgeCost).toBeCloseTo(2 * (5 / 10_000) * perContract * 100, 6);
  });

  it('width floor is the digital one-σ over the reprice horizon: φ(d2)·√(δt/T)', () => {
    const t = 0.5; // years
    const dt = 60_000 / YEAR_MS;
    expect(widthFloor(0, 60_000, t, 1)).toBeCloseTo(0.3989423 * Math.sqrt(dt / t), 6);
    expect(widthFloor(0, 60_000, t, 2)).toBeCloseTo(2 * 0.3989423 * Math.sqrt(dt / t), 6);
    expect(widthFloor(0, 60_000, 0, 1)).toBe(1); // expired ⇒ unquotable
  });

  it('hedge notional per contract is φ(d2)/(σ√T)', () => {
    expect(hedgeNotionalPerContract(0, 0.5, 0.25)).toBeCloseTo(0.3989423 / (0.5 * 0.5), 6);
    expect(hedgeNotionalPerContract(0, 0, 0.25)).toBe(0);
  });

  it('runGrid aggregates per grid point and computes revenue density', () => {
    const mkts = [
      {
        snaps: [
          snap(0, 0.5, [[0.48, 500]] as TapeLevel[], [[0.52, 500]] as TapeLevel[]),
          snap(1_000, 0.5, [[0.48, 500]] as TapeLevel[], [[0.485, 50]] as TapeLevel[]),
          snap(86_400_000, 0.5, [[0.515, 50]] as TapeLevel[], [[0.52, 500]] as TapeLevel[], {
            expiryMs: 200 * 3_600_000,
          }),
        ],
        settledYes: null,
      },
    ];
    // Keep every snap far from expiry so quoting is unaffected.
    mkts[0].snaps.forEach((s) => (s.expiryMs = 200 * 3_600_000));
    const grid = runGrid(mkts, [0.01], [1_000], BASE);
    expect(grid).toHaveLength(1);
    expect(grid[0].fills).toBe(2);
    expect(grid[0].net).toBeCloseTo(1, 10); // $1 captured, frictionless
    // peak collateral 0.49·50 = $24.5 over exactly 1 day of tape
    expect(grid[0].revenueDensity).toBeCloseTo(1 / 24.5, 6);
  });
});
