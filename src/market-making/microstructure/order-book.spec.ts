import { OrderBook, bestBid, bestAsk, midMicros, quotedSpreadMicros } from './order-book';

const book: OrderBook = {
  symbol: 'BTC',
  ts: new Date('2026-01-01T00:00:00Z'),
  bids: [{ priceMicros: 64_990_000_000n, sizeUnits: 2_000_000n, orderCount: 3 }],
  asks: [{ priceMicros: 65_010_000_000n, sizeUnits: 1_000_000n, orderCount: 1 }],
};

describe('OrderBook', () => {
  it('reads best bid/ask, mid and quoted spread', () => {
    expect(bestBid(book)?.priceMicros).toBe(64_990_000_000n);
    expect(bestAsk(book)?.priceMicros).toBe(65_010_000_000n);
    expect(midMicros(book)).toBe(65_000_000_000n);
    expect(quotedSpreadMicros(book)).toBe(20_000_000n);
  });

  it('returns undefined mid when a side is empty', () => {
    expect(midMicros({ ...book, asks: [] })).toBeUndefined();
  });
});
