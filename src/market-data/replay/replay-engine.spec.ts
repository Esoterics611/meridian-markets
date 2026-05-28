import { ReplayEngine } from './replay-engine';
import { MarketDataRepository, MarketBarRow } from '../market-data.repository';

function row(symbol: string, minute: number, close = 100): MarketBarRow {
  return {
    venue: 'mock', symbol,
    ts: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    openMicros: BigInt(close * 1_000_000),
    highMicros: BigInt(close * 1_000_000),
    lowMicros: BigInt(close * 1_000_000),
    closeMicros: BigInt(close * 1_000_000),
    volumeMicros: 100_000_000n,
  };
}

function repoStub(byPair: Record<string, MarketBarRow[]>): MarketDataRepository {
  return {
    barsBetween: async (_v: string, symbol: string) => byPair[symbol] ?? [],
  } as unknown as MarketDataRepository;
}

describe('ReplayEngine', () => {
  it('loadWindow returns bars from every symbol sorted by ts', async () => {
    const repo = repoStub({
      A: [row('A', 0), row('A', 2), row('A', 4)],
      B: [row('B', 1), row('B', 3), row('B', 5)],
    });
    const engine = new ReplayEngine(repo);
    const bars = await engine.loadWindow({
      venue: 'mock', symbols: ['A', 'B'],
      from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(bars.length).toBe(6);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].timestamp.getTime()).toBeGreaterThanOrEqual(bars[i - 1].timestamp.getTime());
    }
  });

  it('loadPairWindow splits into parallel A/B arrays', async () => {
    const repo = repoStub({
      A: [row('A', 0), row('A', 1), row('A', 2)],
      B: [row('B', 0), row('B', 1), row('B', 2)],
    });
    const engine = new ReplayEngine(repo);
    const { a, b } = await engine.loadPairWindow({
      venue: 'mock', symbolA: 'A', symbolB: 'B',
      from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    expect(a.every(x => x.symbol === 'A')).toBe(true);
    expect(b.every(x => x.symbol === 'B')).toBe(true);
  });

  it('reconstitutes float prices from micros (round-trip)', async () => {
    const repo = repoStub({ A: [row('A', 0, 123.45)] });
    const engine = new ReplayEngine(repo);
    const bars = await engine.loadWindow({
      venue: 'mock', symbols: ['A'],
      from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(bars[0].close).toBeCloseTo(123.45);
  });

  it('returns an empty array when no rows match the window', async () => {
    const engine = new ReplayEngine(repoStub({}));
    const bars = await engine.loadWindow({
      venue: 'mock', symbols: ['X'],
      from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(bars).toEqual([]);
  });
});
