import { l2SnapshotToOrderBook, bidSizeAt, askSizeAt, bestBidMicros, bestAskMicros } from './l2-tape';
import { L2Snapshot } from '../../market-data/reference/reference-source.interface';
import { midMicros } from '../microstructure/order-book';

const SNAP: L2Snapshot = {
  symbol: 'BTC',
  ts: new Date(1780504474984),
  bids: [
    { priceMicros: 100_000000n, sizeUnits: 5_000000n, orderCount: 3 },
    { priceMicros: 99_000000n, sizeUnits: 8_000000n, orderCount: 4 },
  ],
  asks: [
    { priceMicros: 101_000000n, sizeUnits: 2_000000n, orderCount: 1 },
    { priceMicros: 102_000000n, sizeUnits: 6_000000n, orderCount: 2 },
  ],
};

describe('l2SnapshotToOrderBook', () => {
  it('maps a neutral snapshot to an OrderBook preserving order + fields', () => {
    const book = l2SnapshotToOrderBook(SNAP);
    expect(book.symbol).toBe('BTC');
    expect(book.ts).toEqual(new Date(1780504474984));
    expect(book.bids[0]).toEqual({ priceMicros: 100_000000n, sizeUnits: 5_000000n, orderCount: 3 });
    expect(book.asks[1]).toEqual({ priceMicros: 102_000000n, sizeUnits: 6_000000n, orderCount: 2 });
    expect(midMicros(book)).toBe(100_500000n); // (100 + 101) / 2
  });
});

describe('l2-tape level helpers', () => {
  it('reads size at a price level and best prices', () => {
    const book = l2SnapshotToOrderBook(SNAP);
    expect(bidSizeAt(book, 100_000000n)).toBe(5_000000n);
    expect(bidSizeAt(book, 99_000000n)).toBe(8_000000n);
    expect(bidSizeAt(book, 50_000000n)).toBe(0n); // no level there
    expect(askSizeAt(book, 101_000000n)).toBe(2_000000n);
    expect(bestBidMicros(book)).toBe(100_000000n);
    expect(bestAskMicros(book)).toBe(101_000000n);
  });
});
