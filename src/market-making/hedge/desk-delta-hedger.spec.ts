import {
  bookDeltaUsd,
  netDeltaByUnderlying,
  computeHedge,
  hedgeFundingCarryUsd,
  hedgeOrderUnits,
  HedgeConfig,
} from './desk-delta-hedger';

const BTC_MID = 100_000_000_000n; // $100,000 · 1e6
const SOL_MID = 150_000_000n; // $150 · 1e6

const cfg = (over: Partial<HedgeConfig> = {}): HedgeConfig => ({
  bandUsd: 5_000,
  betaMap: { BTC: { underlying: 'BTC', beta: 1 }, SOL: { underlying: 'BTC', beta: 1.1 } },
  hedgeTakerBps: 2.5,
  hedgeHalfSpreadBps: 1,
  ...over,
});

describe('DeskDeltaHedger', () => {
  it('bookDeltaUsd = units · price (long ⇒ +, short ⇒ −)', () => {
    expect(bookDeltaUsd({ symbol: 'BTC', inventoryUnits: 2_000_000n, midMicros: BTC_MID })).toBe(200_000);
    expect(bookDeltaUsd({ symbol: 'BTC', inventoryUnits: -2_000_000n, midMicros: BTC_MID })).toBe(-200_000);
  });

  it('beta-maps alts onto a major so one perp hedges the basket (8 books = 1 beta bet)', () => {
    const net = netDeltaByUnderlying(
      [
        { symbol: 'BTC', inventoryUnits: 2_000_000n, midMicros: BTC_MID }, // +$200k
        { symbol: 'SOL', inventoryUnits: 1_000_000n, midMicros: SOL_MID }, // +$150 · beta 1.1 = +$165
      ],
      cfg().betaMap,
    );
    expect(net).toEqual({ BTC: 200_165 });
  });

  it('net-long desk ⇒ a SELL (short-perp) hedge that flattens the residual, costed at taker+half-spread', () => {
    const plan = computeHedge([{ symbol: 'BTC', inventoryUnits: 2_000_000n, midMicros: BTC_MID }], {}, cfg());
    expect(plan.orders).toHaveLength(1);
    const o = plan.orders[0];
    expect(o).toMatchObject({ underlying: 'BTC', side: 'sell', notionalUsd: 200_000, reason: 'open' });
    expect(o.costUsd).toBeCloseTo((200_000 * 3.5) / 1e4, 6); // = $70
    expect(plan.grossDeltaUsd).toBe(200_000);
  });

  it('residual inside the band ⇒ NO order (the dead-band stops churning the spread on noise)', () => {
    // net +$200k, hedge −$196k ⇒ residual +$4k ≤ $5k band.
    const plan = computeHedge([{ symbol: 'BTC', inventoryUnits: 2_000_000n, midMicros: BTC_MID }], { BTC: -196_000 }, cfg());
    expect(plan.orders).toHaveLength(0);
    expect(plan.states[0].residualUsd).toBe(4_000);
  });

  it('flags a FLIP when the rebalance crosses through zero (book direction reversed under the hedge)', () => {
    // current hedge +$50k (long), books now net +$200k ⇒ trade −$250k ⇒ new hedge −$200k.
    const plan = computeHedge([{ symbol: 'BTC', inventoryUnits: 2_000_000n, midMicros: BTC_MID }], { BTC: 50_000 }, cfg());
    expect(plan.orders[0]).toMatchObject({ side: 'sell', notionalUsd: 250_000, reason: 'flip' });
  });

  it('a SHORT hedge earns funding when the rate is positive (longs pay shorts) — carry-positive hedge', () => {
    expect(hedgeFundingCarryUsd(-200_000, 10)).toBeCloseTo(200, 6); // short $200k, +10bps ⇒ +$200
    expect(hedgeFundingCarryUsd(200_000, 10)).toBeCloseTo(-200, 6); // a long hedge would PAY
  });

  it('hedgeOrderUnits round-trips USD notional → 6-dec perp units at the live mid', () => {
    expect(hedgeOrderUnits(200_000, BTC_MID)).toBe(2_000_000n);
    expect(hedgeOrderUnits(0, BTC_MID)).toBe(0n);
  });
});
