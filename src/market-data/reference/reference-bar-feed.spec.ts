import { Bar } from '../../stat-arb/backtest/bar';
import { IReferenceBarSource } from './reference-source.interface';
import { ReferenceBarFeed, ReferencePriceSource, warmupFromReference } from './reference-bar-feed';

function bar(tsMs: number, close: number, symbol = 'EURUSD'): Bar {
  return { symbol, timestamp: new Date(tsMs), open: close, high: close, low: close, close, volume: 0 };
}

// A source whose klines() returns a controllable [closed, forming] window.
class StubSource implements IReferenceBarSource {
  readonly sourceId = 'pyth';
  readonly label = 'stub';
  readonly sampleSymbol = 'EURUSD';
  constructor(public window: Bar[]) {}
  async klines(): Promise<Bar[]> { return this.window; }
}

describe('ReferenceBarFeed', () => {
  it('derives feedId from the source and emits the just-closed bar once', async () => {
    const src = new StubSource([bar(60_000, 1.08), bar(120_000, 1.081)]); // [closed, forming]
    const feed = new ReferenceBarFeed(src, '1m');
    expect(feed.feedId).toBe('ref.pyth');

    const first = await feed.nextBar('EURUSD');
    expect(first?.timestamp.getTime()).toBe(60_000); // the closed bar, not the forming one
    // No new closed bar since last poll → null.
    expect(await feed.nextBar('EURUSD')).toBeNull();

    // A new closed bar appears → emitted.
    src.window = [bar(120_000, 1.081), bar(180_000, 1.082)];
    const next = await feed.nextBar('EURUSD');
    expect(next?.timestamp.getTime()).toBe(120_000);
  });

  it('returns null when the source yields no bars (closed/illiquid market)', async () => {
    const feed = new ReferenceBarFeed(new StubSource([]), '1m');
    expect(await feed.nextBar('EURUSD')).toBeNull();
  });
});

describe('ReferencePriceSource', () => {
  it('prices a symbol from the latest close, in micros', async () => {
    const ps = new ReferencePriceSource(new StubSource([bar(60_000, 1.08), bar(120_000, 1.2345)]), '1m');
    expect(await ps.priceMicros('EURUSD')).toBe(1_234_500n);
  });

  it('throws when no usable price is available', async () => {
    const ps = new ReferencePriceSource(new StubSource([]), '1m');
    await expect(ps.priceMicros('EURUSD')).rejects.toThrow(/unavailable/);
  });
});

describe('warmupFromReference', () => {
  it('aligns two legs on common timestamps', async () => {
    const a = new StubSource([bar(60_000, 1, 'EURUSD'), bar(120_000, 1, 'EURUSD'), bar(180_000, 1, 'EURUSD')]);
    const b = new StubSource([bar(120_000, 2, 'GBPUSD'), bar(180_000, 2, 'GBPUSD')]);
    // warmupFromReference loads both legs from the SAME source instance in prod;
    // here we stub by swapping the window per symbol via a dispatch source.
    const dispatch: IReferenceBarSource = {
      sourceId: 'pyth', label: 'd', sampleSymbol: 'X',
      klines: async (sym) => (sym === 'EURUSD' ? a.window : b.window),
    };
    const { a: outA, b: outB } = await warmupFromReference(dispatch, '1m', 'EURUSD', 'GBPUSD');
    expect(outA.map((x) => x.timestamp.getTime())).toEqual([120_000, 180_000]);
    expect(outB).toHaveLength(2);
  });
});
