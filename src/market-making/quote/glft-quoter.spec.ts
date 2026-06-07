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
});
