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

  it('the hedge P&L offsets the book: short hedge gains when price falls', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    const ctrl = new DeskHedgeController(venue, cfg());
    await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } }); // short 2 BTC @ $100k
    // Mark the book + hedge at $90k: the book's long 2 BTC is −$20k; the short hedge is +~$20k.
    const snap = ctrl.snapshot(longBtc(2_000_000n, 90_000_000_000n), { BTC: 90_000_000_000n });
    expect(snap.hedgePnlUsd).toBeCloseTo(19_960, 0); // +$20k mark-to-market − $40 fee
  });
});
