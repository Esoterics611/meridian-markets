import { alignMany } from './market-data.controller';
import { Bar } from '../stat-arb/backtest/bar';

function bar(t: number, close: number): Bar {
  return { symbol: 'X', timestamp: new Date(t), open: close, high: close, low: close, close, volume: 1 };
}

describe('alignMany', () => {
  it('keeps only timestamps present in every symbol series (inner join)', () => {
    const m = new Map<string, Bar[]>([
      ['A', [bar(1, 10), bar(2, 11), bar(3, 12)]],
      ['B', [bar(2, 20), bar(3, 21), bar(4, 22)]],
      ['C', [bar(2, 30), bar(3, 31)]],
    ]);
    const out = alignMany(m);
    // Only t=2 and t=3 are in all three.
    for (const sym of ['A', 'B', 'C']) {
      expect(out.get(sym)!.map((b) => b.timestamp.getTime())).toEqual([2, 3]);
    }
  });

  it('returns equal-length aligned series', () => {
    const m = new Map<string, Bar[]>([
      ['A', [bar(1, 1), bar(2, 2)]],
      ['B', [bar(1, 1), bar(2, 2), bar(3, 3)]],
    ]);
    const out = alignMany(m);
    const lengths = [...out.values()].map((b) => b.length);
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(2);
  });

  it('handles the empty map', () => {
    expect(alignMany(new Map()).size).toBe(0);
  });
});
