import { IcebergAlgo } from './iceberg';

describe('IcebergAlgo', () => {
  const algo = new IcebergAlgo({ tipSizeUnits: 100n, refillIntervalMs: 2_000 });

  it('emits tip-sized children when the parent divides cleanly', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 500n, maxSlices: 10 });
    expect(slices.length).toBe(5);
    expect(slices.every((s) => s.notionalUnits === 100n)).toBe(true);
  });

  it('puts the residual on the last child when not divisible', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 250n, maxSlices: 10 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(250n);
    expect(slices[slices.length - 1].notionalUnits).toBe(50n);
  });

  it('spaces children at refillIntervalMs', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 400n, maxSlices: 10 });
    expect(slices[0].scheduleOffsetMs).toBe(0);
    expect(slices[1].scheduleOffsetMs).toBe(2_000);
    expect(slices[2].scheduleOffsetMs).toBe(4_000);
  });

  it('respects maxSlices cap (parent under-fills)', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000n, maxSlices: 3 });
    expect(slices.length).toBe(3);
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(300n); // 3 tips, no residual
  });

  it('preserves the parent side', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'SELL', totalNotionalUnits: 300n, maxSlices: 10 });
    expect(slices.every((s) => s.side === 'SELL')).toBe(true);
  });

  it('returns empty for zero notional', () => {
    expect(algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 0n, maxSlices: 10 })).toEqual([]);
  });

  it('throws on non-positive tipSizeUnits', () => {
    expect(() => new IcebergAlgo({ tipSizeUnits: 0n, refillIntervalMs: 1 })).toThrow();
  });

  it('throws when maxSlices < 1', () => {
    expect(() => algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1n, maxSlices: 0 })).toThrow();
  });

  it('single-tip parent emits one child', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 50n, maxSlices: 10 });
    expect(slices.length).toBe(1);
    expect(slices[0].notionalUnits).toBe(50n);
  });
});
