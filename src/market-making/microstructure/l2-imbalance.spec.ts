import { bookImbalanceFromL2 } from './l2-imbalance';
import { L2Snapshot } from '../../market-data/reference/reference-source.interface';

const snap = (bids: [number, number][], asks: [number, number][]): L2Snapshot => ({
  symbol: 'TEST',
  ts: new Date(0),
  bids: bids.map(([p, s]) => ({ priceMicros: BigInt(p), sizeUnits: BigInt(s), orderCount: 1 })),
  asks: asks.map(([p, s]) => ({ priceMicros: BigInt(p), sizeUnits: BigInt(s), orderCount: 1 })),
});

describe('bookImbalanceFromL2', () => {
  it('is +ve when the bid is heavier (buy pressure)', () => {
    expect(bookImbalanceFromL2(snap([[100, 30]], [[101, 10]]), 1)).toBeCloseTo((30 - 10) / 40, 9);
  });

  it('is −ve when the ask is heavier', () => {
    expect(bookImbalanceFromL2(snap([[100, 10]], [[101, 30]]), 1)).toBeCloseTo((10 - 30) / 40, 9);
  });

  it('is 0 for a symmetric book', () => {
    expect(bookImbalanceFromL2(snap([[100, 20]], [[101, 20]]), 1)).toBe(0);
  });

  it('sums only the top-N levels per side', () => {
    const s = snap(
      [[100, 10], [99, 10], [98, 999]],
      [[101, 5], [102, 5], [103, 999]],
    );
    // depth-2 ignores the deep 999s: (20 − 10)/30
    expect(bookImbalanceFromL2(s, 2)).toBeCloseTo((20 - 10) / 30, 9);
  });

  it('returns null when both sides are empty', () => {
    expect(bookImbalanceFromL2(snap([], []), 5)).toBeNull();
  });
});
