import { PovAlgo } from './pov';

describe('PovAlgo', () => {
  it('caps each child at participationPct of interval volume', () => {
    const algo = new PovAlgo({
      participationPct: 10,
      intervalVolumeUnits: 100_000n,
      intervalMs: 60_000,
      horizonMs: 600_000,
    });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 50_000n, maxSlices: 10 });
    for (const s of slices.slice(0, -1)) expect(s.notionalUnits).toBe(10_000n);
  });

  it('fills the parent fully when horizon allows', () => {
    const algo = new PovAlgo({
      participationPct: 10,
      intervalVolumeUnits: 100_000n,
      intervalMs: 60_000,
      horizonMs: 600_000,
    });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 50_000n, maxSlices: 10 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(50_000n);
  });

  it('under-fills when horizon is too short', () => {
    const algo = new PovAlgo({
      participationPct: 10,
      intervalVolumeUnits: 100_000n,
      intervalMs: 60_000,
      horizonMs: 120_000, // 3 slices max
    });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 100 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBeLessThan(1_000_000n);
    expect(slices.length).toBeLessThanOrEqual(3);
  });

  it('schedules children at intervalMs spacing', () => {
    const algo = new PovAlgo({
      participationPct: 10,
      intervalVolumeUnits: 100_000n,
      intervalMs: 30_000,
      horizonMs: 120_000,
    });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 30_000n, maxSlices: 10 });
    expect(slices[0].scheduleOffsetMs).toBe(0);
    expect(slices[1].scheduleOffsetMs).toBe(30_000);
    expect(slices[2].scheduleOffsetMs).toBe(60_000);
  });

  it('preserves the parent side', () => {
    const algo = new PovAlgo({
      participationPct: 10,
      intervalVolumeUnits: 100_000n,
      intervalMs: 60_000,
      horizonMs: 600_000,
    });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'SELL', totalNotionalUnits: 50_000n, maxSlices: 10 });
    expect(slices.every((s) => s.side === 'SELL')).toBe(true);
  });

  it('returns empty for zero notional', () => {
    const algo = new PovAlgo({ participationPct: 10, intervalVolumeUnits: 100_000n, intervalMs: 60_000, horizonMs: 600_000 });
    expect(algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 0n, maxSlices: 5 })).toEqual([]);
  });

  it('respects maxSlices cap', () => {
    const algo = new PovAlgo({ participationPct: 50, intervalVolumeUnits: 1_000n, intervalMs: 60_000, horizonMs: 6_000_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1_000_000n, maxSlices: 3 });
    expect(slices.length).toBe(3);
  });

  it('throws on participationPct out of range', () => {
    expect(() => new PovAlgo({ participationPct: 0, intervalVolumeUnits: 1n, intervalMs: 1, horizonMs: 1 })).toThrow();
    expect(() => new PovAlgo({ participationPct: 101, intervalVolumeUnits: 1n, intervalMs: 1, horizonMs: 1 })).toThrow();
  });

  it('throws on non-positive intervalVolumeUnits', () => {
    expect(() => new PovAlgo({ participationPct: 10, intervalVolumeUnits: 0n, intervalMs: 1, horizonMs: 1 })).toThrow();
  });

  it('throws when maxSlices < 1', () => {
    const algo = new PovAlgo({ participationPct: 10, intervalVolumeUnits: 100n, intervalMs: 1, horizonMs: 1 });
    expect(() => algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 1n, maxSlices: 0 })).toThrow();
  });

  it('last slice carries the residual when not divisible', () => {
    const algo = new PovAlgo({ participationPct: 10, intervalVolumeUnits: 100_000n, intervalMs: 60_000, horizonMs: 600_000 });
    const slices = algo.sliceOrder({ symbol: 'BTC', side: 'BUY', totalNotionalUnits: 35_000n, maxSlices: 10 });
    const total = slices.reduce((s, c) => s + c.notionalUnits, 0n);
    expect(total).toBe(35_000n);
    expect(slices[slices.length - 1].notionalUnits).toBeLessThanOrEqual(10_000n);
  });
});
