import { VwapAlgo } from './vwap';

describe('VwapAlgo', () => {
  it('sizes children in proportion to the volume curve', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 3], horizonMs: 60_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 4_000n, maxSlices: 2 });
    expect(slices.length).toBe(2);
    expect(slices[0].notionalUnits).toBe(1_000n);
    expect(slices[1].notionalUnits).toBe(3_000n);
  });

  it('puts rounding remainder on the biggest-weight slice', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 2], horizonMs: 60_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 100n, maxSlices: 2 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(100n);
    expect(slices[1].notionalUnits).toBeGreaterThan(slices[0].notionalUnits);
  });

  it('aggregates a long curve down to maxSlices', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 1, 1, 1, 1, 1], horizonMs: 60_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_200n, maxSlices: 3 });
    expect(slices.length).toBe(3);
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(1_200n);
    // Roughly even since the input curve is flat.
    for (const s of slices) expect(s.notionalUnits).toBeGreaterThan(0n);
  });

  it('spaces slice offsets evenly across horizonMs', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 2, 1], horizonMs: 90_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 4_000n, maxSlices: 3 });
    expect(slices[0].scheduleOffsetMs).toBe(0);
    expect(slices[1].scheduleOffsetMs).toBe(30_000);
    expect(slices[2].scheduleOffsetMs).toBe(60_000);
  });

  it('returns an empty array when totalNotionalUnits is 0', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 2, 1], horizonMs: 60_000 });
    expect(algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 0n, maxSlices: 3 })).toEqual([]);
  });

  it('preserves the parent side on every child', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 2, 1], horizonMs: 60_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'SELL', totalNotionalUnits: 1_000n, maxSlices: 3 });
    expect(slices.every((s) => s.side === 'SELL')).toBe(true);
  });

  it('throws on empty volumeCurve', () => {
    expect(() => new VwapAlgo({ volumeCurve: [], horizonMs: 60_000 })).toThrow();
  });

  it('throws on negative weight', () => {
    expect(() => new VwapAlgo({ volumeCurve: [1, -1, 2], horizonMs: 60_000 })).toThrow();
  });

  it('throws on all-zero curve', () => {
    expect(() => new VwapAlgo({ volumeCurve: [0, 0, 0], horizonMs: 60_000 })).toThrow();
  });

  it('throws when horizonMs <= 0', () => {
    expect(() => new VwapAlgo({ volumeCurve: [1], horizonMs: 0 })).toThrow();
  });

  it('throws when maxSlices < 1', () => {
    const algo = new VwapAlgo({ volumeCurve: [1, 1], horizonMs: 60_000 });
    expect(() => algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 100n, maxSlices: 0 })).toThrow();
  });
});
