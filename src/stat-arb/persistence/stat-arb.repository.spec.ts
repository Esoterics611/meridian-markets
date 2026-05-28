import { StatArbRepository, StatArbTradeInsert, StatArbNavInsert } from './stat-arb.repository';
import { DbService } from '@database/db.service';
import { EntityManager } from 'typeorm';

// Unit-level tests use a fake DbService that runs the callback against an
// in-memory pseudo-EntityManager. The real SQL path is exercised in the
// integration spec (DB-gated).

interface FakeRow { [k: string]: unknown }

function makeFakeEm(handler: (sql: string, params: unknown[]) => FakeRow[] | Promise<FakeRow[]>) {
  return {
    query: async (sql: string, params: unknown[]) => handler(sql, params ?? []),
  } as unknown as EntityManager;
}

function makeFakeDb(emHandler: (sql: string, params: unknown[]) => FakeRow[]): DbService {
  return {
    runInSerializableTransaction: async <T>(fn: (em: EntityManager) => Promise<T>) =>
      fn(makeFakeEm(emHandler)),
  } as unknown as DbService;
}

const sampleTrade: StatArbTradeInsert = {
  venue: 'mock',
  symbolA: 'BTC',
  symbolB: 'ETH',
  side: 'SHORT',
  entryZ: 1.5,
  exitZ: 0.2,
  entryPriceAMicros: 50_000_000_000n,
  entryPriceBMicros: 2_000_000_000n,
  exitPriceAMicros: 49_500_000_000n,
  exitPriceBMicros: 2_020_000_000n,
  notionalUnits: 1_000_000n,
  pnlUnits: 12_345n,
  feesUnits: 100n,
  openedAt: new Date('2026-01-01T00:00:00Z'),
  closedAt: new Date('2026-01-01T00:30:00Z'),
  idempotencyKey: 'demo-1',
};

const dbReturnsRow: FakeRow = {
  id: '1',
  venue: 'mock', symbolA: 'BTC', symbolB: 'ETH', side: 'SHORT',
  entryZ: 1.5, exitZ: 0.2,
  entryPriceAMicros: '50000000000', entryPriceBMicros: '2000000000',
  exitPriceAMicros: '49500000000', exitPriceBMicros: '2020000000',
  notionalUnits: '1000000', pnlUnits: '12345', feesUnits: '100',
  openedAt: new Date('2026-01-01T00:00:00Z'),
  closedAt: new Date('2026-01-01T00:30:00Z'),
  idempotencyKey: 'demo-1', createdAt: new Date('2026-01-01T00:30:01Z'),
};

describe('StatArbRepository (unit)', () => {
  it('insertTrade returns the row with bigints coerced from strings', async () => {
    let calls = 0;
    const db = makeFakeDb((sql) => {
      calls++;
      if (sql.includes('SELECT') && sql.includes('idempotency_key')) return [];
      return [dbReturnsRow];
    });
    const repo = new StatArbRepository(db);
    const row = await repo.insertTrade(sampleTrade);
    expect(row.notionalUnits).toBe(1_000_000n);
    expect(row.pnlUnits).toBe(12_345n);
    expect(typeof row.openedAt).toBe('object');
    expect(calls).toBe(2); // existence check + insert
  });

  it('insertTrade returns the existing row when idempotency key already used', async () => {
    let inserts = 0;
    const db = makeFakeDb((sql) => {
      if (sql.includes('SELECT') && sql.includes('idempotency_key')) return [dbReturnsRow];
      inserts++;
      return [dbReturnsRow];
    });
    const repo = new StatArbRepository(db);
    const row = await repo.insertTrade(sampleTrade);
    expect(row.idempotencyKey).toBe('demo-1');
    expect(inserts).toBe(0);
  });

  it('insertNav returns null on ON CONFLICT DO NOTHING (empty rows)', async () => {
    const db = makeFakeDb(() => []);
    const repo = new StatArbRepository(db);
    const n: StatArbNavInsert = {
      asOf: new Date('2026-01-01T00:00:00Z'),
      navUnits: 100_000_000n,
      openPositionCount: 0,
    };
    expect(await repo.insertNav(n)).toBeNull();
  });

  it('insertNav returns the inserted row when a row was written', async () => {
    const db = makeFakeDb(() => [{
      id: '1', asOf: new Date('2026-01-01T00:00:00Z'),
      navUnits: '100000000', openPositionCount: 2,
      createdAt: new Date('2026-01-01T00:00:01Z'),
    }]);
    const repo = new StatArbRepository(db);
    const r = await repo.insertNav({ asOf: new Date('2026-01-01T00:00:00Z'), navUnits: 100_000_000n, openPositionCount: 2 });
    expect(r).not.toBeNull();
    expect(r!.navUnits).toBe(100_000_000n);
    expect(r!.openPositionCount).toBe(2);
  });

  it('recentTrades coerces bigints', async () => {
    const db = makeFakeDb(() => [dbReturnsRow]);
    const repo = new StatArbRepository(db);
    const rows = await repo.recentTrades('mock');
    expect(rows[0].notionalUnits).toBe(1_000_000n);
  });

  it('navHistory coerces bigints', async () => {
    const db = makeFakeDb(() => [{
      id: '1', asOf: new Date('2026-01-01T00:00:00Z'),
      navUnits: '99000000', openPositionCount: 1,
      createdAt: new Date('2026-01-01T00:00:01Z'),
    }]);
    const repo = new StatArbRepository(db);
    const rows = await repo.navHistory(new Date('2026-01-01T00:00:00Z'));
    expect(rows[0].navUnits).toBe(99_000_000n);
  });
});
