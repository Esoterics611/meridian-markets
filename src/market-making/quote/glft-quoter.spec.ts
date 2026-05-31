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
});
