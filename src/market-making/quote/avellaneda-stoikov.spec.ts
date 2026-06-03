import { AvellanedaStoikovQuoter } from './avellaneda-stoikov';
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
  return new AvellanedaStoikovQuoter(
    { gamma: 0.0025, kappa: 2, quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 0, maxHalfSpreadBps: 10_000, maxInventoryLots: 50 },
    CLOCK,
  );
}

describe('AvellanedaStoikovQuoter', () => {
  it('puts the reservation price at mid when flat, with bid < ask', () => {
    const f = quoter().quote(ctx({ inventoryUnits: 0n }), 'USDC');
    expect(f.reservationMicros).toBe(1_000_000n);
    expect(f.bid.priceMicros).toBeLessThan(f.ask.priceMicros);
  });

  it('skews BOTH quotes down when long inventory (to make the next ask-fill likelier)', () => {
    const q = quoter();
    const flat = q.quote(ctx({ inventoryUnits: 0n }), 'USDC');
    const long = q.quote(ctx({ inventoryUnits: 2_000_000n }), 'USDC'); // +2 lots
    expect(long.reservationMicros).toBeLessThan(flat.reservationMicros);
    expect(long.bid.priceMicros).toBeLessThan(flat.bid.priceMicros);
    expect(long.ask.priceMicros).toBeLessThan(flat.ask.priceMicros);
  });

  it('skews UP when short inventory', () => {
    const q = quoter();
    const short = q.quote(ctx({ inventoryUnits: -2_000_000n }), 'USDC');
    expect(short.reservationMicros).toBeGreaterThan(1_000_000n);
  });

  it('widens the half-spread as volatility rises', () => {
    const q = quoter();
    const calm = q.quote(ctx({ volatility: 0.001 }), 'USDC');
    const wild = q.quote(ctx({ volatility: 0.002 }), 'USDC');
    expect(wild.halfSpreadMicros).toBeGreaterThan(calm.halfSpreadMicros);
  });

  it('shrinks the half-spread as the horizon runs down (the finite-horizon property)', () => {
    const q = quoter();
    const far = q.quote(ctx({ horizonBars: 1 }), 'USDC');
    const near = q.quote(ctx({ horizonBars: 0.01 }), 'USDC');
    expect(near.halfSpreadMicros).toBeLessThan(far.halfSpreadMicros);
  });

  it('is price-scale-invariant: same bps spread + skew at $1 and $1,900, no blow-up (Journal #17)', () => {
    const q = quoter();
    const lo = q.quote(ctx({ midMicros: 1_000_000n, inventoryUnits: 1_000_000n, volatility: 0.002 }), 'X'); // $1
    const hi = q.quote(ctx({ midMicros: 1_900_000_000n, inventoryUnits: 1_000_000n, volatility: 0.002 }), 'X'); // $1,900
    const halfBps = (p: typeof lo) => (Number(p.halfSpreadMicros) / Number(p.context.midMicros)) * 1e4;
    const skewBps = (p: typeof lo) => ((Number(p.context.midMicros) - Number(p.reservationMicros)) / Number(p.context.midMicros)) * 1e4;
    expect(halfBps(hi)).toBeCloseTo(halfBps(lo), 1); // same half-spread in bps of mid
    expect(skewBps(hi)).toBeCloseTo(skewBps(lo), 1); // same inventory skew in bps of mid
    // the old code sent the $1,900 reservation to a nonsense price; now it stays sane
    expect(Number(hi.reservationMicros)).toBeGreaterThan(Number(hi.context.midMicros) * 0.5);
    expect(Number(hi.reservationMicros)).toBeLessThan(Number(hi.context.midMicros) * 1.5);
  });
});
