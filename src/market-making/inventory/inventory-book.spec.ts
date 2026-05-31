import { InventoryBook } from './inventory-book';

const A = 1_000_000n; // 1.0 asset
const P = (x: number) => BigInt(Math.round(x * 1_000_000)); // price → micros

describe('InventoryBook', () => {
  it('rolls average cost as a position is extended', () => {
    const b = new InventoryBook();
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(1.0), feeUnits: 0n });
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(2.0), feeUnits: 0n });
    expect(b.inventoryUnits()).toBe(2n * A);
    expect(b.avgCost()).toBe(P(1.5));
  });

  it('realises P&L when a long is reduced, leaving avg cost unchanged', () => {
    const b = new InventoryBook();
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(1.0), feeUnits: 0n });
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(2.0), feeUnits: 0n }); // avg 1.5
    b.apply({ side: 'SELL', sizeUnits: A, priceMicros: P(2.0), feeUnits: 0n });
    // sold 1 asset at 2.0, cost 1.5 → +0.5 USDC = 500_000 units.
    expect(b.realisedUnits()).toBe(500_000n);
    expect(b.inventoryUnits()).toBe(A);
    expect(b.avgCost()).toBe(P(1.5));
    expect(b.unrealisedUnits(P(2.0))).toBe(500_000n); // remaining 1 @ cost 1.5, mark 2.0
  });

  it('overshoots through zero and reopens at the fill price', () => {
    const b = new InventoryBook();
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(1.5), feeUnits: 0n });
    b.apply({ side: 'SELL', sizeUnits: 3n * A, priceMicros: P(2.0), feeUnits: 0n });
    // closed 1 long @ (2.0-1.5)=+0.5; remaining 2 short opened at 2.0.
    expect(b.realisedUnits()).toBe(500_000n);
    expect(b.inventoryUnits()).toBe(-2n * A);
    expect(b.avgCost()).toBe(P(2.0));
  });

  it('treats a maker rebate as negative fees that lift net P&L', () => {
    const b = new InventoryBook();
    b.apply({ side: 'BUY', sizeUnits: A, priceMicros: P(1.0), feeUnits: -100n }); // rebate
    expect(b.feesUnits()).toBe(-100n);
    // total = realised(0) − fees(−100) + unrealised(0 at mark 1.0) = +100.
    expect(b.totalPnlUnits(P(1.0))).toBe(100n);
    expect(b.equityUnits(1_000_000n, P(1.0))).toBe(1_000_100n);
  });
});
