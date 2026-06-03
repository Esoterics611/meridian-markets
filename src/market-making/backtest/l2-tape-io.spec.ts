import { serializeTape, parseTape } from './l2-tape-io';
import { L2TapeStep } from './l2-tape';
import { OrderBook } from '../microstructure/order-book';

const ob = (ts: number): OrderBook => ({
  symbol: 'BTC',
  ts: new Date(ts),
  bids: [
    { priceMicros: 65779_000000n, sizeUnits: 10_375820n, orderCount: 49 },
    { priceMicros: 65778_000000n, sizeUnits: 16_932150n, orderCount: 74 },
  ],
  asks: [{ priceMicros: 65780_000000n, sizeUnits: 848570n, orderCount: 4 }],
});

const TAPE: L2TapeStep[] = [
  { book: ob(1_000), aggressiveBuyUnits: 5_000000n, aggressiveSellUnits: 3_000000n, tradedHighMicros: 65790_000000n, tradedLowMicros: 65770_000000n },
  { book: ob(2_000), aggressiveBuyUnits: 0n, aggressiveSellUnits: 1_500000n }, // no traded extremes
];

describe('l2-tape-io round-trip', () => {
  it('serialises and parses back an exact bigint/Date copy', () => {
    const parsed = parseTape(serializeTape(TAPE));
    expect(parsed).toHaveLength(2);
    // bigint fields exact
    expect(parsed[0].book.bids[0]).toEqual({ priceMicros: 65779_000000n, sizeUnits: 10_375820n, orderCount: 49 });
    expect(parsed[0].book.asks[0].sizeUnits).toBe(848570n);
    expect(parsed[0].aggressiveBuyUnits).toBe(5_000000n);
    expect(parsed[0].aggressiveSellUnits).toBe(3_000000n);
    expect(parsed[0].tradedHighMicros).toBe(65790_000000n);
    expect(parsed[0].tradedLowMicros).toBe(65770_000000n);
    // timestamps + symbol preserved
    expect(parsed[0].book.ts).toEqual(new Date(1_000));
    expect(parsed[0].book.symbol).toBe('BTC');
    // optional extremes omitted when absent
    expect(parsed[1].tradedHighMicros).toBeUndefined();
    expect(parsed[1].tradedLowMicros).toBeUndefined();
  });

  it('rejects an unsupported tape version', () => {
    const bad = JSON.stringify({ version: 99, symbol: 'X', steps: [] });
    expect(() => parseTape(bad)).toThrow(/unsupported tape version/);
  });
});
