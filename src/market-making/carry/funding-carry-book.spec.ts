import { FundingCarryBook, FundingCarryBookConfig } from './funding-carry-book';
import { SlippageImpactModel } from '../directional/fill-cost-model';
import { DeskEventInput } from '../events/desk-event';

// Pure unit tests — no network, no DB, no clocks (caller-passed nowMs throughout).

const HOUR_MS = 3_600_000;
const M = 1_000_000n;
const usd = (x: number): bigint => BigInt(Math.round(x * 1e6));
const micros = (px: number): bigint => BigInt(Math.round(px * 1e6));

const BASE: FundingCarryBookConfig = {
  symbol: 'ETH',
  direction: 'SHORT_PERP',
  notionalUsd: 50_000,
  spotFeeBps: 4.5,
  perpFeeBps: 2.5,
  fundingPeriodMs: HOUR_MS, // HL hourly
};

const SPOT = micros(3_000);
const PERP = micros(2_998.8); // −4bps basis (the measured HL discount, #71)

function openBook(cfg: Partial<FundingCarryBookConfig> = {}, t0 = 0): FundingCarryBook {
  const book = new FundingCarryBook({ ...BASE, ...cfg });
  book.open(t0, SPOT, PERP);
  return book;
}

describe('FundingCarryBook — open/close mechanics', () => {
  it('opens two equal-quantity, offsetting legs (delta-neutral) and charges both fees', () => {
    const events: DeskEventInput[] = [];
    const book = openBook({ onEvent: (e) => events.push(e) });
    const snap = book.snapshot(SPOT, PERP, 0);
    expect(snap.isOpen).toBe(true);
    expect(snap.qtyUnits).toBeGreaterThan(0n);
    // Leg notional ≈ $50k at the perp mark.
    expect(Number(snap.legNotionalUnits) / 1e6).toBeCloseTo(50_000, 0);
    // Fees: one side of each leg = (4.5 + 2.5)bps on ~$50k ≈ $35.
    expect(Number(snap.feesUnits) / 1e6).toBeCloseTo(35, 0);
    // Entry basis recorded (≈ −4bps).
    expect(snap.entryBasisBps).toBeCloseTo(-4, 1);
    // Both leg fills hit the tape.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['fill', 'fill']);
  });

  it('rejects double-open, close-when-flat, and bad config', () => {
    const book = openBook();
    expect(() => book.open(1, SPOT, PERP)).toThrow(/already open/);
    const flat = new FundingCarryBook(BASE);
    expect(() => flat.close(0, SPOT, PERP)).toThrow(/not open/);
    expect(() => new FundingCarryBook({ ...BASE, notionalUsd: 0 })).toThrow();
    expect(() => new FundingCarryBook({ ...BASE, fundingPeriodMs: 0 })).toThrow();
    expect(() => new FundingCarryBook({ ...BASE, maxLeverage: 0 })).toThrow();
  });

  it('close realises and flattens; accrual becomes a no-op after close', () => {
    const book = openBook();
    book.close(HOUR_MS, SPOT, PERP);
    const snap = book.snapshot(SPOT, PERP, HOUR_MS);
    expect(snap.isOpen).toBe(false);
    expect(snap.basisUnrealisedUnits).toBe(0n);
    // Same mids in/out, no slippage ⇒ realised 0, fees = 2 round-trip sides ≈ $70.
    expect(snap.realisedUnits).toBe(0n);
    expect(Number(snap.feesUnits) / 1e6).toBeCloseTo(70, 0);
    expect(book.accrueFunding(2 * HOUR_MS, 0.001, PERP)).toBe(0n);
  });
});

describe('FundingCarryBook — E2 executed-fill path (openWithExecutions/closeWithExecutions)', () => {
  // Maker fills at the touch: spot BUY at the bid (below mid), perp SELL at the ask
  // (above mid) — both price-IMPROVED vs mid — with the maker fee (spot +1bps) and
  // the HL maker REBATE (−0.2bps) instead of the taker schedule.
  const spotExec = { priceMicros: micros(2_999.7), feeBps: 1, midMicros: SPOT }; // BUY 30¢ under mid
  const perpExec = { priceMicros: micros(2_999.1), feeBps: -0.2, midMicros: PERP }; // SELL 30¢ over mid

  it('ledgers executed prices, signed fees (rebate = revenue), and NEGATIVE slippage on price improvement', () => {
    const book = new FundingCarryBook(BASE);
    book.openWithExecutions(0, spotExec, perpExec);
    const snap = book.snapshot(SPOT, PERP, 0);
    expect(snap.isOpen).toBe(true);
    expect(Number(snap.legNotionalUnits) / 1e6).toBeCloseTo(50_000, 0);
    // Fees: +1bps on ~$50k (spot) − 0.2bps on ~$50k (perp rebate) ≈ $5 − $1 = $4.
    expect(Number(snap.feesUnits) / 1e6).toBeCloseTo(4, 0);
    // Both legs beat their mids by ~$0.30 on ~16.67 units ⇒ ~−$10 signed slippage (improvement).
    expect(Number(snap.slippageUnits) / 1e6).toBeCloseTo(-10, 0);
    // Basis baseline anchors at the MIDS, not the executed prices.
    expect(snap.entryBasisBps).toBeCloseTo(-4, 1);
  });

  it('round trip at executed prices realises the executed spread, and the net identity holds', () => {
    const book = new FundingCarryBook(BASE);
    book.openWithExecutions(0, spotExec, perpExec);
    book.accrueFunding(HOUR_MS, 0.0001, PERP);
    // Close both legs maker at the touch again: spot SELL above mid, perp BUY below mid.
    book.closeWithExecutions(
      HOUR_MS,
      { priceMicros: micros(3_000.3), feeBps: 1, midMicros: SPOT },
      { priceMicros: micros(2_998.5), feeBps: -0.2, midMicros: PERP },
    );
    const snap = book.snapshot(SPOT, PERP, HOUR_MS);
    expect(snap.isOpen).toBe(false);
    // Each leg earned its touch-to-touch spread: spot +60¢/unit, perp +60¢/unit on ~16.67 units ≈ +$20.
    expect(Number(snap.realisedUnits) / 1e6).toBeCloseTo(20, 0);
    expect(snap.netUnits).toBe(snap.realisedUnits - snap.feesUnits + snap.fundingUnits);
    // Four price-improved fills ⇒ the signed slippage diagnostic is firmly negative.
    expect(snap.slippageUnits).toBeLessThan(0n);
  });

  it('guards: no double-open, no close-when-flat, no zero prices/mids', () => {
    const book = new FundingCarryBook(BASE);
    expect(() => book.closeWithExecutions(0, spotExec, perpExec)).toThrow(/not open/);
    book.openWithExecutions(0, spotExec, perpExec);
    expect(() => book.openWithExecutions(1, spotExec, perpExec)).toThrow(/already open/);
    const flat = new FundingCarryBook(BASE);
    expect(() => flat.openWithExecutions(0, { ...spotExec, priceMicros: 0n }, perpExec)).toThrow(/> 0/);
  });

  it('taker path is unchanged: the SlippageImpactModel still reports POSITIVE slippage', () => {
    const book = new FundingCarryBook({ ...BASE, fillModel: new SlippageImpactModel({ halfSpreadBps: 1 }) });
    book.open(0, SPOT, PERP);
    expect(book.snapshot(SPOT, PERP, 0).slippageUnits).toBeGreaterThan(0n);
  });
});

describe('FundingCarryBook — funding accrual (time-weighted; the #72 60× bug regression)', () => {
  const RATE = 0.0000125; // +0.125bps/h — the #72 ETH rate

  it('60 one-minute accruals equal ONE one-hour accrual (never per-poll)', () => {
    const polled = openBook();
    for (let i = 1; i <= 60; i++) polled.accrueFunding(i * 60_000, RATE, PERP);
    const once = openBook();
    once.accrueFunding(HOUR_MS, RATE, PERP);
    const a = polled.snapshot(SPOT, PERP).fundingUnits;
    const b = once.snapshot(SPOT, PERP).fundingUnits;
    // Identical up to 60 sub-cent rounding steps.
    expect(Math.abs(Number(a - b))).toBeLessThanOrEqual(60);
    // And the HONEST magnitude: $50k × 0.125bps ≈ $0.625 for the hour — not $37.50.
    expect(Number(b) / 1e6).toBeCloseTo(0.625, 2);
  });

  it('signs by direction: SHORT_PERP receives positive funding, LONG_PERP pays it', () => {
    const short = openBook();
    expect(short.accrueFunding(HOUR_MS, RATE, PERP)).toBeGreaterThan(0n);
    expect(short.accrueFunding(2 * HOUR_MS, -RATE, PERP)).toBeLessThan(0n);
    const long = openBook({ direction: 'LONG_PERP' });
    expect(long.accrueFunding(HOUR_MS, RATE, PERP)).toBeLessThan(0n);
    expect(long.accrueFunding(2 * HOUR_MS, -RATE, PERP)).toBeGreaterThan(0n);
  });

  it('ignores a non-advancing clock and accrues nothing when flat', () => {
    const book = openBook();
    book.accrueFunding(HOUR_MS, RATE, PERP);
    expect(book.accrueFunding(HOUR_MS, RATE, PERP)).toBe(0n); // same ts
    expect(book.accrueFunding(HOUR_MS - 1, RATE, PERP)).toBe(0n); // backwards
    const flat = new FundingCarryBook(BASE);
    expect(flat.accrueFunding(HOUR_MS, RATE, PERP)).toBe(0n);
  });
});

describe('FundingCarryBook — basis P&L (directional moves wash out)', () => {
  it('a +10% move on BOTH legs nets to ~the basis residual, not the directional move', () => {
    const book = openBook();
    const up = book.snapshot(micros(3_300), micros(3_298.68), 0); // both +10%, basis preserved
    const directionalMove = 5_000; // $50k × 10% per leg
    // The wash residual is the entry basis × the move (~$0.5), orders below the $5k move.
    expect(Math.abs(Number(up.basisUnrealisedUnits) / 1e6)).toBeLessThan(directionalMove * 0.005);
  });

  it('SHORT_PERP profits when the basis narrows (perp falls vs spot), loses when it widens', () => {
    const book = openBook();
    // Perp −10bps, spot flat ⇒ basis narrows ⇒ short-perp leg gains.
    const narrow = book.snapshot(SPOT, micros(2_998.8 * 0.999), 0);
    expect(narrow.basisUnrealisedUnits).toBeGreaterThan(0n);
    // Perp +10bps, spot flat ⇒ basis widens against the short.
    const widen = book.snapshot(SPOT, micros(2_998.8 * 1.001), 0);
    expect(widen.basisUnrealisedUnits).toBeLessThan(0n);
  });

  it('net identity: net = realised − fees + funding + basisUnrealised, exactly', () => {
    const book = openBook();
    book.accrueFunding(6 * HOUR_MS, 0.0000125, PERP);
    const s = book.snapshot(micros(3_010), micros(3_007), 6 * HOUR_MS);
    expect(s.netUnits).toBe(s.realisedUnits - s.feesUnits + s.fundingUnits + s.basisUnrealisedUnits);
    expect(s.realisedFirstUnits).toBe(s.realisedUnits - s.feesUnits + s.fundingUnits);
  });
});

describe('FundingCarryBook — honest fills (slippage) and margin', () => {
  it('a slippage model worsens both legs and reports the cost separately', () => {
    const frictionless = openBook();
    const slipped = openBook({ fillModel: new SlippageImpactModel({ halfSpreadBps: 5 }) });
    const a = frictionless.snapshot(SPOT, PERP, 0);
    const b = slipped.snapshot(SPOT, PERP, 0);
    expect(a.slippageUnits).toBe(0n);
    // 5bps on ~$50k × 2 legs ≈ $50 of slippage.
    expect(Number(b.slippageUnits) / 1e6).toBeCloseTo(50, 0);
    // The cost lands in the mark: slipped net is worse by ≈ the slippage.
    expect(Number(a.netUnits - b.netUnits) / 1e6).toBeCloseTo(Number(b.slippageUnits) / 1e6, 0);
  });

  it('margin: each leg posts notional/maxLeverage; a one-leg loss trips wouldLiquidate at maintenanceFrac', () => {
    const book = openBook({ maxLeverage: 4, maintenanceFrac: 0.5 });
    const flatSnap = book.snapshot(SPOT, PERP, 0);
    expect(Number(flatSnap.marginPerLegUnits) / 1e6).toBeCloseTo(12_500, 0); // 50k/4
    expect(flatSnap.wouldLiquidate).toBe(false);
    // Perp rallies +15% against the short leg: loss ≈ $7.5k ≥ 0.5 × $12.5k margin.
    const stressed = book.snapshot(micros(3_450), micros(2_998.8 * 1.15), 0);
    expect(stressed.perpMarginUtil).toBeGreaterThanOrEqual(0.5);
    expect(stressed.wouldLiquidate).toBe(true);
    // The delta-neutral pair as a WHOLE is fine — that is exactly the honesty point.
    expect(Math.abs(Number(stressed.basisUnrealisedUnits))).toBeLessThan(Number(stressed.marginPerLegUnits));
  });

  it('a flat book never reports liquidation risk', () => {
    const flat = new FundingCarryBook(BASE);
    const s = flat.snapshot(SPOT, PERP, 0);
    expect(s.spotMarginUtil).toBe(0);
    expect(s.perpMarginUtil).toBe(0);
    expect(s.wouldLiquidate).toBe(false);
  });
});

describe('FundingCarryBook — persistence (the #47 rehydrate trap)', () => {
  it('serialize → restore reproduces the identical snapshot AND the identical next accrual', () => {
    const original = openBook();
    original.accrueFunding(2 * HOUR_MS, 0.0000125, PERP);

    const revived = new FundingCarryBook(BASE);
    revived.restoreState(JSON.parse(JSON.stringify(original.serializeState())));

    // Identical state...
    expect(revived.snapshot(SPOT, PERP, 3 * HOUR_MS)).toEqual(original.snapshot(SPOT, PERP, 3 * HOUR_MS));
    // ...and the accrual clock survived: the SAME next tick accrues the SAME funding.
    const dOrig = original.accrueFunding(5 * HOUR_MS, 0.0000125, PERP);
    const dRevived = revived.accrueFunding(5 * HOUR_MS, 0.0000125, PERP);
    expect(dRevived).toBe(dOrig);
    expect(dRevived).toBeGreaterThan(0n); // 3h of positive funding, not zero, not doubled
    expect(revived.snapshot(SPOT, PERP).fundingUnits).toBe(original.snapshot(SPOT, PERP).fundingUnits);
  });

  it('refuses to restore a mismatched symbol/direction', () => {
    const state = openBook().serializeState();
    const other = new FundingCarryBook({ ...BASE, symbol: 'BTC' });
    expect(() => other.restoreState(state)).toThrow(/does not match/);
    const flipped = new FundingCarryBook({ ...BASE, direction: 'LONG_PERP' });
    expect(() => flipped.restoreState(state)).toThrow(/does not match/);
  });
});
