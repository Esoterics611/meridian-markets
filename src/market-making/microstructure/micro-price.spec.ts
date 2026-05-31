import { MicroPriceCalculator } from './micro-price';
import { OrderBook } from './order-book';

describe('MicroPriceCalculator', () => {
  it('overweights the thinner side', () => {
    const book: OrderBook = {
      symbol: 'X',
      ts: new Date('2026-01-01T00:00:00Z'),
      bids: [{ priceMicros: 100_000_000n, sizeUnits: 1n, orderCount: 1 }], // thin bid
      asks: [{ priceMicros: 101_000_000n, sizeUnits: 100n, orderCount: 1 }], // thick ask
    };
    const mp = new MicroPriceCalculator({ depth: 1 }).compute(book)!;
    // Thin bid → micro price pulled toward the bid, below the 100.5 mid.
    expect(mp).toBeLessThan(100_500_000);
    expect(mp).toBeGreaterThan(100_000_000);
  });

  it('returns undefined when a side is empty', () => {
    const book: OrderBook = { symbol: 'X', ts: new Date(), bids: [], asks: [] };
    expect(new MicroPriceCalculator({ depth: 1 }).compute(book)).toBeUndefined();
  });
});
