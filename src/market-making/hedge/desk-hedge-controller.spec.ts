import { DeskHedgeController } from './desk-hedge-controller';
import { HedgeConfig, BookDelta } from './desk-delta-hedger';
import { PaperVenue } from '../../execution/paper-venue';

const cfg = (over: Partial<HedgeConfig> = {}): HedgeConfig => ({
  bandUsd: 5_000,
  betaMap: { BTC: { underlying: 'BTC', beta: 1 } },
  hedgeTakerBps: 2.5,
  hedgeHalfSpreadBps: 1,
  ...over,
});

// A PaperVenue whose mid we can move — the executing leg of the hedge.
function venueAt(price: Record<string, bigint>) {
  return new PaperVenue({ pricePoller: async (s) => price[s], takerFeeBps: 2n });
}

const longBtc = (units: bigint, mid: bigint): BookDelta[] => [{ symbol: 'BTC', inventoryUnits: units, midMicros: mid }];
const BTC_100K = 100_000_000_000n;

describe('DeskHedgeController (executes the hedge on a PaperVenue)', () => {
  it('a net-long desk gets SHORTED on the venue until the residual is flat', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    const snap = await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // +$200k delta

    expect(snap.ordersLastTick).toHaveLength(1);
    expect(snap.ordersLastTick[0]).toMatchObject({ side: 'sell', notionalUsd: 200_000 });
    expect(venue.bookSnapshot()).toHaveLength(1); // the taker order really hit the venue
    expect(venue.bookSnapshot()[0].side).toBe('SELL');
    expect(snap.perUnderlying[0].hedgeUnits).toBeCloseTo(-2, 6); // short 2 BTC
    expect(snap.perUnderlying[0].hedgeNotionalUsd).toBeCloseTo(-200_000, 0);
    expect(Math.abs(snap.residualUsd)).toBeLessThanOrEqual(cfg().bandUsd); // flat within the band
    expect(snap.hedgePnlUsd).toBeCloseTo(-40, 0); // no move yet ⇒ P&L is just the taker fee
  });

  it('leaves a within-band delta alone (no churn, nothing hits the venue)', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    const snap = await ctrl.rebalance(longBtc(30_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // +$3k ≤ $5k band
    expect(snap.ordersLastTick).toHaveLength(0);
    expect(venue.bookSnapshot()).toHaveLength(0);
  });

  it('the short hedge EARNS funding when the rate is positive (carry-positive)', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // open the short hedge
    // 1h later, +0.01%/hr funding on the −$200k short ⇒ +$20 received, no new trade.
    const snap = await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), {
      prices: { BTC: BTC_100K },
      fundingRatePerHour: { BTC: 0.0001 },
      dtHours: 1,
    });
    expect(snap.ordersLastTick).toHaveLength(0);
    expect(snap.fundingUsd).toBeCloseTo(20, 6);
  });

  it('does NOT churn or blow up P&L when the underlying price flickers out of the map (Journal #45)', async () => {
    // A cross-asset map (SUI→ETH) + the underlying's price dropping out every other tick — exactly
    // what happens live when a book goes un-warm / mid-relaunch (deskDeltas skips mid≤0). Before the
    // last-known-mark fix this marked the open ETH hedge at 0 (phantom P&L) and re-traded every tick.
    const ETH = 1_673_000_000n;
    const SUI = 750_000n;
    const hedgeMids: Record<string, bigint> = {};
    const venue = new PaperVenue({ pricePoller: async (s) => hedgeMids[s] ?? 0n, takerFeeBps: 2n });
    const ctrl = new DeskHedgeController(
      venue,
      cfg({ bandUsd: 2000, betaMap: { SUI: { underlying: 'ETH', beta: 1.3 } } }),
      () => new Date(),
      (p) => Object.assign(hedgeMids, p),
    );
    const books: BookDelta[] = [{ symbol: 'SUI', inventoryUnits: -10_000_000_000n, midMicros: SUI }]; // −$7.5k × β1.3

    let orders = 0;
    let last;
    for (let i = 0; i < 40; i++) {
      // ETH price present only on even ticks; SUI always present, delta unchanged.
      const prices: Record<string, bigint> = i % 2 === 0 ? { SUI, ETH } : { SUI };
      last = await ctrl.rebalance(books, { prices, dtHours: 0.0001 });
      orders += last.ordersLastTick.length;
    }

    // Converges to a SINGLE opening trade, then holds — no per-tick churn across the flicker.
    expect(orders).toBe(1);
    // And the hedge P&L stays ~the taker fee (no phantom mark-at-0 swing of thousands).
    expect(Math.abs(ctrl.snapshot(books, { SUI }).hedgePnlUsd)).toBeLessThan(10);
    // The held position is valued even on a tick whose ETH price is missing (last-known mark).
    expect(ctrl.snapshot(books, { SUI }).perUnderlying.find((u) => u.underlying === 'ETH')!.hedgeNotionalUsd).toBeGreaterThan(9000);
  });

  it('reset() drops the hedge book to flat — snapshot reads zero gross/residual/P&L (no ghost)', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // open a −2 BTC hedge
    expect(ctrl.snapshot(longBtc(2_000_000n, BTC_100K), { BTC: BTC_100K }).perUnderlying).toHaveLength(1);

    const legs = ctrl.reset();
    expect(legs).toBe(1); // reported one perp leg closed (for the desk tape)

    // closeAll removes the books BEFORE resetting the hedge — so the post-close snapshot sees no
    // books and no held perp ⇒ a true flat 000 (this is what makes the UI land on zero, not a ghost).
    const snap = ctrl.snapshot([], {});
    expect(snap.grossDeltaUsd).toBe(0);
    expect(snap.residualUsd).toBe(0);
    expect(snap.hedgePnlUsd).toBe(0);
    expect(snap.perUnderlying).toHaveLength(0);
  });

  it('the hedge P&L offsets the book: short hedge gains when price falls', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // short 2 BTC @ $100k
    // Mark the book + hedge at $90k: the book's long 2 BTC is −$20k; the short hedge is +~$20k.
    const snap = ctrl.snapshot(longBtc(2_000_000n, 90_000_000_000n), { BTC: 90_000_000_000n });
    expect(snap.hedgePnlUsd).toBeCloseTo(19_960, 0); // +$20k mark-to-market − $40 fee
  });
});
