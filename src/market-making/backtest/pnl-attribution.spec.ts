import { attributeFill, sumComponents } from './pnl-attribution';

const A = 1_000_000n;
const P = (x: number) => BigInt(Math.round(x * 1_000_000));

describe('attributeFill', () => {
  it('credits spread captured on a sell above the fair mid', () => {
    // Sell 1 @ 1.0005, fair mid 1.0, mark-out flat → pure spread, no adverse.
    const c = attributeFill({ side: 'SELL', sizeUnits: A, priceMicros: P(1.0005), feeUnits: 0n }, P(1.0), P(1.0), 0n);
    expect(c.spreadCapturedUnits).toBe(500n);
    expect(c.adverseSelectionUnits).toBe(0n);
  });

  it('books adverse selection when the mid runs against the new position', () => {
    // Sell 1 @ fair 1.0; mid then rises to 1.001 → we are short into a rally.
    const c = attributeFill({ side: 'SELL', sizeUnits: A, priceMicros: P(1.0), feeUnits: 0n }, P(1.0), P(1.001), 0n);
    expect(c.adverseSelectionUnits).toBeGreaterThan(0n);
  });

  it('sums components across fills', () => {
    const c1 = attributeFill({ side: 'SELL', sizeUnits: A, priceMicros: P(1.0005), feeUnits: -50n }, P(1.0), P(1.0), 0n);
    const c2 = attributeFill({ side: 'BUY', sizeUnits: A, priceMicros: P(0.9995), feeUnits: -50n }, P(1.0), P(1.0), 0n);
    const s = sumComponents([c1, c2]);
    expect(s.spreadCapturedUnits).toBe(1_000n); // 500 + 500
    expect(s.feesUnits).toBe(-100n);
  });
});
