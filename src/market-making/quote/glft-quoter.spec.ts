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
});
