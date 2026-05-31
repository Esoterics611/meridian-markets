import { SymmetricQuoter } from './symmetric-quoter';
import { QuoteContext } from './quote-pair';

const CLOCK = () => new Date('2026-01-01T00:00:00Z');

function ctx(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    inventoryUnits: 0n,
    midMicros: 1_000_000n,
    volatility: 0.0002,
    riskAversion: 0.0025,
    arrivalDecay: 2,
    horizonBars: 1,
    schemaVersion: 1,
    ...over,
  };
}

describe('SymmetricQuoter', () => {
  it('quotes symmetrically around mid, ignoring inventory', () => {
    const q = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }, CLOCK);
    const flat = q.quote(ctx({ inventoryUnits: 0n }), 'USDC');
    const long = q.quote(ctx({ inventoryUnits: 50_000_000n }), 'USDC');
    // 5 bps of 1.0 = 500 micros half-spread either side.
    expect(flat.reservationMicros).toBe(1_000_000n);
    expect(flat.bid.priceMicros).toBe(999_500n);
    expect(flat.ask.priceMicros).toBe(1_000_500n);
    // Inventory does not move a symmetric quote — that is the whole point.
    expect(long.bid.priceMicros).toBe(flat.bid.priceMicros);
    expect(long.ask.priceMicros).toBe(flat.ask.priceMicros);
    expect(flat.bid.postOnly).toBe(true);
    expect(flat.bid.priceMicros).toBeLessThan(flat.ask.priceMicros);
  });
});
