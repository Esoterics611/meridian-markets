import { GlftQuoter } from './glft-quoter';
import { QuoteContext } from './quote-pair';

const CLOCK = () => new Date('2026-01-01T00:00:00Z');

function ctx(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    inventoryUnits: 0n,
    midMicros: 1_000_000n,
    volatility: 0.001,
    riskAversion: 0.0025,
    arrivalDecay: 2,
    horizonBars: 1,
    schemaVersion: 1,
    ...over,
  };
}

function quoter() {
  return new GlftQuoter(
    { gamma: 0.0025, kappa: 2, quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 0, maxHalfSpreadBps: 10_000, maxInventoryLots: 50, steadyHorizonBars: 1 },
    CLOCK,
  );
}

describe('GlftQuoter', () => {
  it('still skews with inventory (the AS mechanism is preserved)', () => {
    const q = quoter();
    const flat = q.quote(ctx({ inventoryUnits: 0n }), 'USDC');
    const long = q.quote(ctx({ inventoryUnits: 2_000_000n }), 'USDC');
    expect(long.reservationMicros).toBeLessThan(flat.reservationMicros);
  });

  it('is INVARIANT to the horizon countdown — the steady-state distinction from AS', () => {
    const q = quoter();
    const a = q.quote(ctx({ horizonBars: 0.01 }), 'USDC');
    const b = q.quote(ctx({ horizonBars: 100 }), 'USDC');
    expect(a.halfSpreadMicros).toBe(b.halfSpreadMicros);
    expect(a.reservationMicros).toBe(b.reservationMicros);
  });

  it('centers the reservation on referenceMicros (the micro-price / theo) when supplied', () => {
    const q = quoter();
    // Flat inventory ⇒ reservation == the center. Mid 1.000000, micro-price 1.000500.
    const onMid = q.quote(ctx({ inventoryUnits: 0n }), 'USDC');
    const onMicro = q.quote(ctx({ inventoryUnits: 0n, referenceMicros: 1_000_500n }), 'USDC');
    expect(onMid.reservationMicros).toBe(1_000_000n); // legacy: centered on the mid
    expect(onMicro.reservationMicros).toBe(1_000_500n); // shifted to the micro-price
    // Spread width unchanged — only the center moved (we quote a better price, not wider).
    expect(onMicro.halfSpreadMicros).toBe(onMid.halfSpreadMicros);
  });

  it('F3: spreadScale tightens (<1) and widens (>1) the half-spread; 1/undefined unchanged', () => {
    const q = quoter();
    const base = q.quote(ctx({ inventoryUnits: 0n }), 'USDC');
    const tight = q.quote(ctx({ inventoryUnits: 0n, spreadScale: 0.5 }), 'USDC');
    const wide = q.quote(ctx({ inventoryUnits: 0n, spreadScale: 2 }), 'USDC');
    expect(Number(tight.halfSpreadMicros)).toBeLessThan(Number(base.halfSpreadMicros));
    expect(Number(wide.halfSpreadMicros)).toBeGreaterThan(Number(base.halfSpreadMicros));
    // The center is untouched — only the spread scales.
    expect(tight.reservationMicros).toBe(base.reservationMicros);
    expect(q.quote(ctx({ inventoryUnits: 0n, spreadScale: 1 }), 'USDC').halfSpreadMicros).toBe(base.halfSpreadMicros);
  });

  it('referenceMicros === midMicros reproduces the mid-quoter exactly (swap-seam default)', () => {
    const q = quoter();
    const a = q.quote(ctx({ inventoryUnits: 3_000_000n }), 'USDC');
    const b = q.quote(ctx({ inventoryUnits: 3_000_000n, referenceMicros: 1_000_000n }), 'USDC');
    expect(b.reservationMicros).toBe(a.reservationMicros);
    expect(b.bid.priceMicros).toBe(a.bid.priceMicros);
    expect(b.ask.priceMicros).toBe(a.ask.priceMicros);
  });

  it('is price-scale-invariant: same bps spread + skew at $1 and $1,900, no blow-up (Journal #17)', () => {
    const q = quoter();
    const lo = q.quote(ctx({ midMicros: 1_000_000n, inventoryUnits: 1_000_000n, volatility: 0.002 }), 'X');
    const hi = q.quote(ctx({ midMicros: 1_900_000_000n, inventoryUnits: 1_000_000n, volatility: 0.002 }), 'X');
    const halfBps = (p: typeof lo) => (Number(p.halfSpreadMicros) / Number(p.context.midMicros)) * 1e4;
    const skewBps = (p: typeof lo) => ((Number(p.context.midMicros) - Number(p.reservationMicros)) / Number(p.context.midMicros)) * 1e4;
    expect(halfBps(hi)).toBeCloseTo(halfBps(lo), 1);
    expect(skewBps(hi)).toBeCloseTo(skewBps(lo), 1);
    expect(Number(hi.reservationMicros)).toBeGreaterThan(Number(hi.context.midMicros) * 0.5);
    expect(Number(hi.reservationMicros)).toBeLessThan(Number(hi.context.midMicros) * 1.5);
  });

  // The inventory governor (Journal #39): the bare A-S skew was ~2 bps at full inventory,
  // and nothing stopped the book breaching its cap — inventory carry was the whole loss.
  describe('inventory governor', () => {
    const P = { gamma: 0.0025, kappa: 2, quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 0, steadyHorizonBars: 1 };
    const capped = (over: Record<string, unknown> = {}) =>
      new GlftQuoter({ ...P, maxHalfSpreadBps: 200, maxInventoryLots: 2, hardInventoryCap: true, ...over }, CLOCK);

    it('inventorySkewMult pushes the reservation further from flat WITHOUT widening the spread', () => {
      const base = new GlftQuoter({ ...P, maxHalfSpreadBps: 10_000, maxInventoryLots: 50 }, CLOCK);
      const strong = new GlftQuoter({ ...P, maxHalfSpreadBps: 10_000, maxInventoryLots: 50, inventorySkewMult: 10 }, CLOCK);
      const c = ctx({ inventoryUnits: 3_000_000n }); // long
      const b = base.quote(c, 'X');
      const s = strong.quote(c, 'X');
      expect(Number(s.reservationMicros)).toBeLessThan(Number(b.reservationMicros)); // skews harder toward flat
      expect(s.halfSpreadMicros).toBe(b.halfSpreadMicros); // spread untouched
    });

    it('hardInventoryCap parks the BID at the rail over the long cap (cannot add to a long)', () => {
      const over = capped().quote(ctx({ inventoryUnits: 3_000_000n }), 'X'); // 3 lots > 2-lot cap
      const resv = Number(over.reservationMicros);
      const maxMicros = (Number(over.context.midMicros) * 200) / 10_000;
      expect(resv - Number(over.bid.priceMicros)).toBe(maxMicros); // bid pushed out to the max rail
      expect(resv - Number(over.bid.priceMicros)).toBeGreaterThan(Number(over.ask.priceMicros) - resv); // ask still sheds
    });

    it('hardInventoryCap parks the ASK at the rail over the short cap (cannot add to a short)', () => {
      const over = capped().quote(ctx({ inventoryUnits: -3_000_000n }), 'X');
      const resv = Number(over.reservationMicros);
      const maxMicros = (Number(over.context.midMicros) * 200) / 10_000;
      expect(Number(over.ask.priceMicros) - resv).toBe(maxMicros);
      expect(Number(over.ask.priceMicros) - resv).toBeGreaterThan(resv - Number(over.bid.priceMicros));
    });

    it('defaults (mult 1, cap off) reproduce the legacy quoter bit-for-bit', () => {
      const legacy = quoter();
      const same = new GlftQuoter({ ...P, maxHalfSpreadBps: 10_000, maxInventoryLots: 50, inventorySkewMult: 1, hardInventoryCap: false }, CLOCK);
      const c = ctx({ inventoryUnits: 5_000_000n });
      expect(same.quote(c, 'X').bid.priceMicros).toBe(legacy.quote(c, 'X').bid.priceMicros);
      expect(same.quote(c, 'X').ask.priceMicros).toBe(legacy.quote(c, 'X').ask.priceMicros);
    });
  });

  // The notional inventory cap (Journal #41): a fixed lot count is a 100×-different bet across
  // a wide price universe (4 lots of BTC ≫ 4 lots of DOGE) — BTC drew 10% on "4 lots". The cap
  // is recomputed each tick as frac·capital ÷ (price·lotUnits), so it binds the same RISK.
  describe('notional inventory cap', () => {
    const P = { gamma: 0.0025, kappa: 2, quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 0, steadyHorizonBars: 1, maxHalfSpreadBps: 200 };
    const CAP = 1_000_000_000_000n; // $1,000,000 book in micro-USD
    // 10% of $1M = $100k notional budget; one lot = 1 coin (quoteSizeUnits 1e6).
    const notional = () => new GlftQuoter({ ...P, maxInventoryLots: 50, hardInventoryCap: true, maxInventoryNotionalFrac: 0.1, capitalUnits: CAP }, CLOCK);
    const parkedBid = (p: ReturnType<GlftQuoter['quote']>) =>
      Number(p.reservationMicros) - Number(p.bid.priceMicros) === (Number(p.context.midMicros) * 200) / 10_000;

    it('binds far below the lot cap on a high-priced book ($100k mid ⇒ ~1-lot notional budget)', () => {
      // 2 lots is well under the 50-lot count cap, but $200k ≫ the $100k notional budget ⇒ park.
      const btc = notional().quote(ctx({ midMicros: 100_000_000_000n, inventoryUnits: 2_000_000n }), 'BTC');
      expect(parkedBid(btc)).toBe(true);
    });

    it('does NOT bind on a low-priced book at the same lot count (same $ budget, far more lots)', () => {
      // $1 mid: the $100k budget is 100,000 lots, so 2 lots is nowhere near the cap.
      const doge = notional().quote(ctx({ midMicros: 1_000_000n, inventoryUnits: 2_000_000n }), 'DOGE');
      expect(parkedBid(doge)).toBe(false);
    });

    it('parks at the same NOTIONAL regardless of price (scale-invariant risk): 2× price ⇒ ½ the lots', () => {
      // At $200k mid the budget is ½ a lot, so even 0.6 lots (600k units) breaches the cap…
      const hi = notional().quote(ctx({ midMicros: 200_000_000_000n, inventoryUnits: 600_000n }), 'BTC');
      // …while at $100k the same 0.6 lots is $60k < $100k budget ⇒ no park.
      const lo = notional().quote(ctx({ midMicros: 100_000_000_000n, inventoryUnits: 600_000n }), 'BTC');
      expect(parkedBid(hi)).toBe(true);
      expect(parkedBid(lo)).toBe(false);
    });

    it('frac 0 / unset ⇒ the legacy lot-count cap (no notional binding)', () => {
      const off = new GlftQuoter({ ...P, maxInventoryLots: 50, hardInventoryCap: true, maxInventoryNotionalFrac: 0, capitalUnits: CAP }, CLOCK);
      // Same BTC case that parked above — with the notional cap off, 2 lots < 50-lot cap ⇒ no park.
      const btc = off.quote(ctx({ midMicros: 100_000_000_000n, inventoryUnits: 2_000_000n }), 'BTC');
      expect(parkedBid(btc)).toBe(false);
    });
  });
});
