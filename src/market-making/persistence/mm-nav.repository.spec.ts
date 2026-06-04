import { MmNavRepository, MmNavInsert } from './mm-nav.repository';
import { DbService } from '@database/db.service';
import { EntityManager } from 'typeorm';

// Unit tests use a fake DbService that runs the callback against an in-memory
// pseudo-EntityManager (same harness as stat-arb.repository.spec.ts). The real
// SQL path is exercised by the DB-gated round-trip in mm-nav.repository.int-spec.ts.

interface FakeRow { [k: string]: unknown }

function makeFakeEm(handler: (sql: string, params: unknown[]) => FakeRow[]) {
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

function deskRow(over: Partial<MmNavInsert> = {}): MmNavInsert {
  return {
    asOf: new Date('2026-01-01T00:00:00Z'),
    bookKey: '',
    equityUnits: 100_000_000_000n,
    netPnlUnits: 0n,
    realisedPnlUnits: 0n,
    unrealisedPnlUnits: 0n,
    feesUnits: 0n,
    fundingUnits: 0n,
    inventoryUnits: 0n,
    maxDrawdownPct: 0,
    ...over,
  };
}

describe('MmNavRepository (unit)', () => {
  it('insertNavSnapshot writes every row in one txn and returns the count', async () => {
    let seenSql = '';
    let seenParams: unknown[] = [];
    const db = makeFakeDb((sql, params) => {
      seenSql = sql;
      seenParams = params;
      // Mimic RETURNING id for each VALUES tuple.
      const rowCount = (sql.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1;
      return Array.from({ length: rowCount }, (_, i) => ({ id: String(i + 1) }));
    });
    const repo = new MmNavRepository(db);
    const n = await repo.insertNavSnapshot([
      deskRow({ equityUnits: 100_000_500_000n }),
      deskRow({ bookKey: 'BTC', equityUnits: 50_000_250_000n, inventoryUnits: 791_600n }),
    ]);
    expect(n).toBe(2);
    expect(seenSql).toContain('INSERT INTO mm_nav');
    // 10 columns × 2 rows = 20 bound params; bigints are passed as decimal strings.
    expect(seenParams).toHaveLength(20);
    expect(seenParams[2]).toBe('100000500000');
    expect(seenParams).toContain('791600');
  });

  it('insertNavSnapshot is a no-op (0 rows) when given an empty batch', async () => {
    let called = false;
    const db = makeFakeDb(() => {
      called = true;
      return [];
    });
    const repo = new MmNavRepository(db);
    expect(await repo.insertNavSnapshot([])).toBe(0);
    expect(called).toBe(false); // never opens a transaction for nothing
  });

  it('navHistory coerces bigints + dates and defaults to the desk series', async () => {
    let bookKeyParam: unknown;
    const db = makeFakeDb((_sql, params) => {
      bookKeyParam = params[0];
      return [
        {
          id: '1', asOf: new Date('2026-01-01T00:00:00Z'), bookKey: '',
          equityUnits: '100000500000', netPnlUnits: '500000', realisedPnlUnits: '400000',
          unrealisedPnlUnits: '100000', feesUnits: '-2000', fundingUnits: '-1000',
          inventoryUnits: '0', maxDrawdownPct: 0.53,
          createdAt: new Date('2026-01-01T00:00:01Z'),
        },
      ];
    });
    const repo = new MmNavRepository(db);
    const rows = await repo.navHistory(new Date('2026-01-01T00:00:00Z'));
    expect(bookKeyParam).toBe(''); // desk series by default
    expect(rows[0].equityUnits).toBe(100_000_500_000n);
    expect(rows[0].feesUnits).toBe(-2_000n);
    expect(rows[0].maxDrawdownPct).toBeCloseTo(0.53);
    expect(rows[0].asOf instanceof Date).toBe(true);
  });

  it('navHistory passes a per-book key through to the WHERE clause', async () => {
    let bookKeyParam: unknown;
    const db = makeFakeDb((_sql, params) => {
      bookKeyParam = params[0];
      return [];
    });
    const repo = new MmNavRepository(db);
    await repo.navHistory(new Date('2026-01-01T00:00:00Z'), 'BTC');
    expect(bookKeyParam).toBe('BTC');
  });
});
