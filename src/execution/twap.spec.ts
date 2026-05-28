import { TwapAlgo } from './twap';

describe('TwapAlgo', () => {
  const algo = new TwapAlgo({ horizonMs: 60_000 });

  it('slices a parent into N equally-sized children when N divides cleanly', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000n, maxSlices: 4 });
    expect(slices.length).toBe(4);
    expect(slices.every(s => s.notionalUnits === 250n)).toBe(true);
  });

  it('puts the rounding remainder on the last slice', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_003n, maxSlices: 4 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(1_003n);
    expect(slices[slices.length - 1].notionalUnits).toBeGreaterThanOrEqual(slices[0].notionalUnits);
  });

  it('spaces slice offsets evenly across horizonMs', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000n, maxSlices: 4 });
    expect(slices[0].scheduleOffsetMs).toBe(0);
    expect(slices[1].scheduleOffsetMs).toBe(15_000);
    expect(slices[2].scheduleOffsetMs).toBe(30_000);
    expect(slices[3].scheduleOffsetMs).toBe(45_000);
  });

  it('returns an empty array when totalNotionalUnits is 0', () => {
    expect(algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 0n, maxSlices: 4 })).toEqual([]);
  });

  it('throws when horizonMs <= 0', () => {
    expect(() => new TwapAlgo({ horizonMs: 0 })).toThrow();
  });

  it('throws when maxSlices < 1', () => {
    expect(() => algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 100n, maxSlices: 0 })).toThrow();
  });

  it('preserves the parent side on every child', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'SELL', totalNotionalUnits: 1_000n, maxSlices: 5 });
    expect(slices.every(s => s.side === 'SELL')).toBe(true);
  });

  it('single-slice mode returns the parent as one child', () => {
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 100n, maxSlices: 1 });
    expect(slices.length).toBe(1);
    expect(slices[0].notionalUnits).toBe(100n);
    expect(slices[0].scheduleOffsetMs).toBe(0);
  });
});
