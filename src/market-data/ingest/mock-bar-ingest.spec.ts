import { MockBarIngest } from './mock-bar-ingest';
import { Bar } from '../../stat-arb/backtest/bar';

function bars(symbol: string, n: number, start = 0): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    timestamp: new Date(Date.UTC(2026, 0, 1) + (start + i) * 60_000),
    open: 1, high: 1, low: 1, close: 1, volume: 1,
  }));
}

describe('MockBarIngest', () => {
  it('emits one bar per loaded symbol per batch by default', async () => {
    const ing = new MockBarIngest();
    ing.loadFixture('A', bars('A', 3));
    ing.loadFixture('B', bars('B', 3));
    const batch = await ing.nextBatch();
    expect(batch.length).toBe(2);
    expect(new Set(batch.map(x => x.symbol))).toEqual(new Set(['A', 'B']));
  });

  it('advances cursors so consecutive batches return next bars', async () => {
    const ing = new MockBarIngest();
    ing.loadFixture('A', bars('A', 3));
    const b1 = await ing.nextBatch();
    const b2 = await ing.nextBatch();
    expect(b1[0].bar.timestamp.getTime()).toBeLessThan(b2[0].bar.timestamp.getTime());
  });

  it('emits batchSize bars per symbol when configured', async () => {
    const ing = new MockBarIngest();
    ing.setBatchSize(3);
    ing.loadFixture('A', bars('A', 10));
    const batch = await ing.nextBatch();
    expect(batch.length).toBe(3);
  });

  it('returns an empty batch once every fixture is exhausted', async () => {
    const ing = new MockBarIngest();
    ing.loadFixture('A', bars('A', 2));
    await ing.nextBatch();
    await ing.nextBatch();
    expect(await ing.nextBatch()).toEqual([]);
    expect(ing.isExhausted()).toBe(true);
  });

  it('reset rewinds every cursor', async () => {
    const ing = new MockBarIngest();
    ing.loadFixture('A', bars('A', 3));
    await ing.nextBatch();
    await ing.nextBatch();
    ing.reset();
    const batch = await ing.nextBatch();
    expect(batch[0].bar.timestamp.getUTCHours()).toBe(0);
  });

  it('rejects setBatchSize(0)', () => {
    expect(() => new MockBarIngest().setBatchSize(0)).toThrow();
  });
});
