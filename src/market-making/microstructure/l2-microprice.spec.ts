import { microPriceMicrosFromL2 } from './l2-microprice';
import { L2Snapshot } from '../../market-data/reference/reference-source.interface';

function snap(over: Partial<L2Snapshot> = {}): L2Snapshot {
  return {
    symbol: 'BTC',
    ts: new Date('2026-06-07T00:00:00Z'),
    bids: [{ priceMicros: 100_000_000n, sizeUnits: 1_000_000n, orderCount: 1 }], // 100.00 × 1.0
    asks: [{ priceMicros: 100_100_000n, sizeUnits: 1_000_000n, orderCount: 1 }], // 100.10 × 1.0
    ...over,
  };
}

describe('microPriceMicrosFromL2', () => {
  it('returns the plain mid when both sides carry equal size', () => {
    // equal size ⇒ micro-price == mid = (100.00 + 100.10)/2 = 100.05
    expect(microPriceMicrosFromL2(snap(), 1)).toBe(100_050_000n);
  });

  it('leans toward the ask when the bid is thicker (thin side is closer to true price)', () => {
    // bigger bid size ⇒ weight the ASK vwap more ⇒ micro-price > mid (toward 100.10)
    const mp = microPriceMicrosFromL2(
      snap({ bids: [{ priceMicros: 100_000_000n, sizeUnits: 9_000_000n, orderCount: 1 }] }),
      1,
    );
    expect(mp).not.toBeNull();
    expect(mp!).toBeGreaterThan(100_050_000n);
    expect(mp!).toBeLessThanOrEqual(100_100_000n);
  });

  it('leans toward the bid when the ask is thicker', () => {
    const mp = microPriceMicrosFromL2(
      snap({ asks: [{ priceMicros: 100_100_000n, sizeUnits: 9_000_000n, orderCount: 1 }] }),
      1,
    )!;
    expect(mp).toBeLessThan(100_050_000n);
    expect(mp).toBeGreaterThanOrEqual(100_000_000n);
  });

  it('returns null when a side is empty (no fair value to quote around)', () => {
    expect(microPriceMicrosFromL2(snap({ bids: [] }), 1)).toBeNull();
    expect(microPriceMicrosFromL2(snap({ asks: [] }), 1)).toBeNull();
  });
});
