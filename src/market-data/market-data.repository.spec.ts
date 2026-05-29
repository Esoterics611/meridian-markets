import { MarketDataRepository, priceToMicros, microsToPrice, rowToBar } from './market-data.repository';
import { DbService } from '@database/db.service';
import { EntityManager } from 'typeorm';
import { Bar } from '../stat-arb/backtest/bar';

function fakeDb(handler: (sql: string, params: unknown[]) => unknown[]): DbService {
  return {
    runInSerializableTransaction: async <T>(fn: (em: EntityManager) => Promise<T>) =>
      fn({ query: async (sql: string, params: unknown[]) => handler(sql, params ?? []) } as unknown as EntityManager),
  } as unknown as DbService;
}

function bar(close: number): Bar {
  return {
    symbol: 'BTC-USDT.spot.binance',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    open: close, high: close, low: close, close, volume: 1,
  };
}

describe('priceToMicros / microsToPrice', () => {
  it('round-trip with 6-decimal precision', () => {
    expect(microsToPrice(priceToMicros(123.456789))).toBeCloseTo(123.456789, 5);
  });

  it('rejects non-finite / negative input by returning 0n', () => {
    expect(priceToMicros(NaN)).toBe(0n);
    expect(priceToMicros(-5)).toBe(0n);
  });
});

describe('MarketDataRepository (unit)', () => {
  it('insertBars returns the count of newly inserted rows', async () => {
    let calls = 0;
    const db = fakeDb(() => {
      calls++;
      // Even-numbered inserts succeed; odd-numbered are conflicts.
      return calls % 2 === 1 ? [{ count: '1' }] : [];
    });
    const repo = new MarketDataRepository(db);
    const n = await repo.insertBars([
      { venue: 'mock', symbol: 'A', bar: bar(100) },
      { venue: 'mock', symbol: 'A', bar: bar(101) },
      { venue: 'mock', symbol: 'A', bar: bar(102) },
    ]);
    expect(n).toBe(2);
  });

  it('insertGap returns null when ON CONFLICT DO NOTHING swallowed the row', async () => {
    const db = fakeDb(() => []);
    const repo = new MarketDataRepository(db);
    const r = await repo.insertGap({
      venue: 'mock', symbol: 'A',
      gapStart: new Date('2026-01-01T00:00:00Z'),
      gapEnd: new Date('2026-01-01T00:05:00Z'),
      missingBars: 4,
    });
    expect(r).toBeNull();
  });

  it('insertGap returns the inserted row when present', async () => {
    const db = fakeDb(() => [{
      id: '1', venue: 'mock', symbol: 'A',
      gapStart: new Date('2026-01-01T00:00:00Z'),
      gapEnd: new Date('2026-01-01T00:05:00Z'),
      missingBars: 4,
      detectedAt: new Date('2026-01-01T00:05:01Z'),
    }]);
    const repo = new MarketDataRepository(db);
    const r = await repo.insertGap({
      venue: 'mock', symbol: 'A',
      gapStart: new Date('2026-01-01T00:00:00Z'),
      gapEnd: new Date('2026-01-01T00:05:00Z'),
      missingBars: 4,
    });
    expect(r).not.toBeNull();
    expect(r!.missingBars).toBe(4);
  });

  it('barsBetween coerces bigints', async () => {
    const db = fakeDb(() => [{
      venue: 'mock', symbol: 'A',
      ts: new Date('2026-01-01T00:00:00Z'),
      openMicros: '100000000', highMicros: '100000000',
      lowMicros: '100000000', closeMicros: '100000000',
      volumeMicros: '1000000',
    }]);
    const repo = new MarketDataRepository(db);
    const rows = await repo.barsBetween('mock', 'A', new Date(0), new Date(Date.UTC(2027, 0, 1)));
    expect(rows[0].closeMicros).toBe(100_000_000n);
  });

  it('distinctSymbols maps the symbol column', async () => {
    const db = fakeDb(() => [{ symbol: 'BTC' }, { symbol: 'ETH' }]);
    const repo = new MarketDataRepository(db);
    expect(await repo.distinctSymbols('binance.spot')).toEqual(['BTC', 'ETH']);
  });

  it('barsForSymbols buckets rows by symbol and coerces bigints', async () => {
    const db = fakeDb(() => [
      { venue: 'binance.spot', symbol: 'BTC', ts: new Date('2026-01-01T00:00:00Z'),
        openMicros: '1', highMicros: '1', lowMicros: '1', closeMicros: '70000000000', volumeMicros: '1' },
      { venue: 'binance.spot', symbol: 'ETH', ts: new Date('2026-01-01T00:00:00Z'),
        openMicros: '1', highMicros: '1', lowMicros: '1', closeMicros: '3500000000', volumeMicros: '1' },
      { venue: 'binance.spot', symbol: 'BTC', ts: new Date('2026-01-01T00:01:00Z'),
        openMicros: '1', highMicros: '1', lowMicros: '1', closeMicros: '70100000000', volumeMicros: '1' },
    ]);
    const repo = new MarketDataRepository(db);
    const out = await repo.barsForSymbols('binance.spot', ['BTC', 'ETH'], new Date(0), new Date(Date.UTC(2027, 0, 1)));
    expect(out.get('BTC')).toHaveLength(2);
    expect(out.get('ETH')).toHaveLength(1);
    expect(out.get('BTC')![0].closeMicros).toBe(70_000_000_000n);
  });

  it('barsForSymbols short-circuits on an empty symbol list', async () => {
    let called = false;
    const db = fakeDb(() => { called = true; return []; });
    const repo = new MarketDataRepository(db);
    const out = await repo.barsForSymbols('binance.spot', [], new Date(0), new Date());
    expect(out.size).toBe(0);
    expect(called).toBe(false);
  });

  it('rowToBar reconstructs the Bar shape', () => {
    const b = rowToBar({
      venue: 'mock', symbol: 'A',
      ts: new Date('2026-01-01T00:00:00Z'),
      openMicros: 100_000_000n, highMicros: 101_000_000n,
      lowMicros: 99_000_000n, closeMicros: 100_500_000n,
      volumeMicros: 1_000_000n,
    });
    expect(b.close).toBeCloseTo(100.5);
    expect(b.high).toBeCloseTo(101);
  });
});
