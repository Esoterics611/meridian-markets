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

  it('surfaces the §0 hedge-quality KPI (factor-vs-basis residual variance) on the snapshot', async () => {
    const venue = venueAt({ BTC: BTC_100K });
    let nowMs = 0;
    const ctrl = new DeskHedgeController(venue, cfg({ qualityBucketMs: 1000 }), () => new Date(nowMs));
    // Two ticks with a real price move: the tracker primes on the first and measures the second.
    await ctrl.rebalance(longBtc(2_000_000n, BTC_100K), { prices: { BTC: BTC_100K } });
    nowMs = 1_000;
    const snap = await ctrl.rebalance(longBtc(2_000_000n, 101_000_000_000n), { prices: { BTC: 101_000_000_000n } });

    expect(snap.quality).toBeDefined();
    expect(snap.quality!.samples).toBe(1);
    const btcQ = snap.quality!.perBook.find((b) => b.symbol === 'BTC')!;
    // A self-hedged book: its own move IS the factor — zero basis, β=1.
    expect(btcQ.betaLive).toBeCloseTo(1, 6);
    expect(btcQ.basisVolUsdPerHour).toBeCloseTo(0, 6);
    expect(btcQ.pnlVolUsdPerHour).toBeGreaterThan(0);

    // reset() (the closeAll ritual) starts the KPI fresh — no stale variance from a closed desk.
    ctrl.reset();
    expect(ctrl.snapshot([], {}).quality!.samples).toBe(0);
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

describe('DeskHedgeController — hedge-only underlyings (no quoted book) via resolveMid', () => {
  const ETH_4K = 4_000_000_000n;
  const solOnEth = (units: bigint): BookDelta[] => [{ symbol: 'SOL', inventoryUnits: units, midMicros: 200_000_000n }];
  const ethCfg = cfg({ betaMap: { SOL: { underlying: 'ETH', beta: 1 } } });

  it('without resolveMid an ETH order is silently skipped (the Sweet-16 unhedged-desk bug)', async () => {
    const venue = venueAt({ ETH: ETH_4K });
    const ctrl = new DeskHedgeController(venue, ethCfg);
    // +$10k SOL delta mapped onto ETH, but no ETH book ⇒ no ETH price ⇒ order skipped.
    const snap = await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    expect(venue.bookSnapshot()).toHaveLength(0);
    expect(snap.perUnderlying[0]).toMatchObject({ underlying: 'ETH', hedgeNotionalUsd: 0 });
    expect(Math.abs(snap.residualUsd)).toBeCloseTo(10_000, 0); // carried UNHEDGED
  });

  it('with resolveMid the ETH leg marks off the venue mid and the hedge fills', async () => {
    const venue = venueAt({ ETH: ETH_4K });
    const calls: string[] = [];
    const ctrl = new DeskHedgeController(
      venue,
      ethCfg,
      () => new Date(),
      undefined,
      async (u) => {
        calls.push(u);
        return ETH_4K;
      },
    );
    const snap = await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    expect(calls).toEqual(['ETH']);
    expect(venue.bookSnapshot()).toHaveLength(1);
    expect(venue.bookSnapshot()[0].side).toBe('SELL'); // short ETH against the long SOL delta
    expect(snap.perUnderlying[0].hedgeNotionalUsd).toBeCloseTo(-10_000, 0);
    expect(Math.abs(snap.residualUsd)).toBeLessThanOrEqual(ethCfg.bandUsd);
  });

  it('throttles the resolver: a second rebalance inside midRefreshMs reuses the cached mark', async () => {
    const venue = venueAt({ ETH: ETH_4K });
    let calls = 0;
    let nowMs = 1_000_000;
    const ctrl = new DeskHedgeController(
      venue,
      ethCfg,
      () => new Date(nowMs),
      undefined,
      async () => {
        calls += 1;
        return ETH_4K;
      },
      1_000,
    );
    await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    nowMs += 200; // inside the 1s refresh window
    await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    expect(calls).toBe(1);
    nowMs += 2_000; // window elapsed ⇒ refresh
    await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    expect(calls).toBe(2);
  });

  it('a failing resolver never sinks the tick (order skipped, no throw)', async () => {
    const venue = venueAt({ ETH: ETH_4K });
    const ctrl = new DeskHedgeController(
      venue,
      ethCfg,
      () => new Date(),
      undefined,
      async () => {
        throw new Error('venue down');
      },
    );
    const snap = await ctrl.rebalance(solOnEth(50_000_000n), { prices: { SOL: 200_000_000n } });
    expect(snap.perUnderlying[0].hedgeNotionalUsd).toBe(0);
  });
});
