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
