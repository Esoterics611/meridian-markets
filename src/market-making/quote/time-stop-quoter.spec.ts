import { TimeStopQuoter } from './time-stop-quoter';
import { SymmetricQuoter } from './symmetric-quoter';
import { QuoteContext } from './quote-pair';

const MID = 1_000_000n; // $1.00

function ctx(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    inventoryUnits: 0n,
    midMicros: MID,
    volatility: 0.0004,
    riskAversion: 0.005,
    arrivalDecay: 2,
    horizonBars: 1,
    schemaVersion: 1,
    ...over,
  };
}

function stop(over: Partial<ConstructorParameters<typeof TimeStopQuoter>[1]> = {}) {
  return new TimeStopQuoter(new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }), {
    ageMs: 60_000,
    rampMs: 60_000,
    maxShiftBps: 10,
    flatUnits: 500_000n,
    ...over,
  });
}

describe('TimeStopQuoter (the S2 inventory time-stop)', () => {
  it('is a pure passthrough while flat, young, or clockless', () => {
    const q = stop();
    const base = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n });
    // flat
    let a = q.quote(ctx({ nowMs: 0 }), 'X');
    let b = base.quote(ctx({ nowMs: 0 }), 'X');
    expect(a.bid.priceMicros).toBe(b.bid.priceMicros);
    // long but young (30s < 60s)
    a = q.quote(ctx({ inventoryUnits: 5_000_000n, nowMs: 0 }), 'X');
    a = q.quote(ctx({ inventoryUnits: 5_000_000n, nowMs: 30_000 }), 'X');
    b = base.quote(ctx({ inventoryUnits: 5_000_000n, nowMs: 30_000 }), 'X');
    expect(a.ask.priceMicros).toBe(b.ask.priceMicros);
    // no clock ⇒ dormant even when aged inventory would otherwise trigger
    a = q.quote(ctx({ inventoryUnits: 5_000_000n }), 'X');
    b = base.quote(ctx({ inventoryUnits: 5_000_000n }), 'X');
    expect(a.ask.priceMicros).toBe(b.ask.priceMicros);
  });

  it('shifts BOTH quotes down on an aged long, ramping to maxShiftBps (width preserved)', () => {
    const q = stop();
    const base = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n });
    const long = (now: number) => ctx({ inventoryUnits: 5_000_000n, nowMs: now });
    q.quote(long(0), 'X'); // anchor
    const ref = base.quote(long(180_000), 'X');
    const shifted = q.quote(long(180_000), 'X'); // age 180s = ageMs+2×ramp ⇒ full strength
    const expectedShift = BigInt(Math.round((Number(MID) * 10) / 10_000)); // 10bps of $1 mid
    expect(shifted.ask.priceMicros).toBe(ref.ask.priceMicros - expectedShift);
    expect(shifted.bid.priceMicros).toBe(ref.bid.priceMicros - expectedShift);
    // width unchanged
    expect(shifted.ask.priceMicros - shifted.bid.priceMicros).toBe(ref.ask.priceMicros - ref.bid.priceMicros);
    // half ramp ⇒ half shift
    const q2 = stop();
    q2.quote(long(0), 'X');
    const half = q2.quote(long(90_000), 'X'); // 30s past ageMs of 60s ramp ⇒ 50%
    expect(half.ask.priceMicros).toBe(ref.ask.priceMicros - expectedShift / 2n);
  });

  it('shifts UP on an aged short, and a sign flip resets the clock', () => {
    const q = stop();
    const base = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n });
    const short = (now: number) => ctx({ inventoryUnits: -5_000_000n, nowMs: now });
    q.quote(short(0), 'X');
    const shifted = q.quote(short(180_000), 'X');
    const ref = base.quote(short(180_000), 'X');
    expect(shifted.bid.priceMicros).toBeGreaterThan(ref.bid.priceMicros);
    // flip to long ⇒ anchor resets ⇒ passthrough
    const flipped = q.quote(ctx({ inventoryUnits: 5_000_000n, nowMs: 181_000 }), 'X');
    const refLong = base.quote(ctx({ inventoryUnits: 5_000_000n, nowMs: 181_000 }), 'X');
    expect(flipped.bid.priceMicros).toBe(refLong.bid.priceMicros);
  });

  it('going flat re-anchors and emits the deactivation transition exactly once', () => {
    const events: Array<{ active: boolean }> = [];
    const q = stop({ onChange: (s) => events.push({ active: s.active }) });
    const long = (now: number) => ctx({ inventoryUnits: 5_000_000n, nowMs: now });
    q.quote(long(0), 'X');
    q.quote(long(180_000), 'X'); // activates
    q.quote(long(181_000), 'X'); // stays active — no duplicate event
    q.quote(ctx({ inventoryUnits: 0n, nowMs: 182_000 }), 'X'); // flat ⇒ deactivates
    expect(events).toEqual([{ active: true }, { active: false }]);
  });
});

describe('TimeStopQuoter proportional control (fullUnits)', () => {
  it('shift fades with |inventory| so the stop cannot swing the book through flat', () => {
    const base = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n });
    const q = new TimeStopQuoter(base, {
      ageMs: 60_000, rampMs: 60_000, maxShiftBps: 10, flatUnits: 500_000n, fullUnits: 4_000_000n,
    });
    const long = (inv: bigint, now: number) => ctx({ inventoryUnits: inv, nowMs: now });
    q.quote(long(4_000_000n, 0), 'X');
    const full = q.quote(long(4_000_000n, 180_000), 'X'); // 4 lots = fullUnits ⇒ full 10bps
    const ref = base.quote(long(4_000_000n, 180_000), 'X');
    expect(full.ask.priceMicros).toBe(ref.ask.priceMicros - 1_000n); // 10bps of $1
    const quarter = q.quote(long(1_000_000n, 181_000), 'X'); // 1 lot = ¼ ⇒ 2.5bps
    const ref2 = base.quote(long(1_000_000n, 181_000), 'X');
    expect(quarter.ask.priceMicros).toBe(ref2.ask.priceMicros - 250n);
  });
});
