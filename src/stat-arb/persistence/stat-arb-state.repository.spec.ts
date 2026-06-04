import { StatArbStateRepository } from './stat-arb-state.repository';
import { StatArbBookRecord } from './stat-arb-state-store.interface';
import { DbService } from '@database/db.service';
import { EntityManager } from 'typeorm';

// Unit-level tests use a fake DbService that captures the SQL + params and
// returns canned rows, exercising the upsert/load/close SQL shape offline. The
// real DB path is covered by the integration suite (DB-gated, CI only).

interface FakeRow {
  [k: string]: unknown;
}
interface Captured {
  sql: string;
  params: unknown[];
}

function makeFakeDb(rows: FakeRow[], captured: Captured[]): DbService {
  const em = {
    query: async (sql: string, params: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return rows;
    },
  } as unknown as EntityManager;
  return {
    runInSerializableTransaction: async <T>(fn: (em: EntityManager) => Promise<T>) => fn(em),
  } as unknown as DbService;
}

const sampleState = () => ({
  realisedPnlUnits: '15832000',
  closedTradeCount: 3,
  peakNav: 1.02,
  barsSeen: 240,
  seededBars: 60,
  blockedEntries: 1,
  open: {
    side: 'LONG' as const,
    notionalUnits: '500000000',
    entryZ: -2.1,
    entryPriceAMicros: '100000000',
    entryPriceBMicros: '50000000',
    entryFeesUnits: '250000',
    openedAt: new Date(1_000_000).toISOString(),
  },
});

const sample = (): StatArbBookRecord => ({
  bookKey: 'ETH/BTC',
  symbolA: 'ETH',
  symbolB: 'BTC',
  source: 'binance',
  strategyId: 'bollinger-pairs',
  beta: 0.85,
  params: { entryZ: 2 },
  notionalUnits: 500_000_000n,
  capitalUnits: 1_000_000_000n,
  running: true,
  state: sampleState(),
});

describe('StatArbStateRepository (unit)', () => {
  it('upsert sends an INSERT … ON CONFLICT with bigints as strings + JSONB blobs', async () => {
    const captured: Captured[] = [];
    const repo = new StatArbStateRepository(makeFakeDb([], captured));
    await repo.upsert(sample());
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toMatch(/INSERT INTO stat_arb_book_state/);
    expect(captured[0].sql).toMatch(/ON CONFLICT \(book_key\) DO UPDATE/);
    const p = captured[0].params;
    expect(p[0]).toBe('ETH/BTC'); // book_key
    expect(p[7]).toBe('500000000'); // notional_units as string
    expect(p[8]).toBe('1000000000'); // capital_units as string
    expect(p[6]).toBe(JSON.stringify({ entryZ: 2 })); // params JSONB
    expect(p[10]).toContain('"realisedPnlUnits":"15832000"'); // state JSONB blob
  });

  it('loadOpen filters status=OPEN and coerces bigints back from strings', async () => {
    const captured: Captured[] = [];
    const row: FakeRow = {
      book_key: 'ETH/BTC', symbol_a: 'ETH', symbol_b: 'BTC', source: 'binance',
      strategy_id: 'bollinger-pairs', beta: 0.85, params: { entryZ: 2 },
      notional_units: '500000000', capital_units: '1000000000', running: true,
      state: sampleState(),
    };
    const repo = new StatArbStateRepository(makeFakeDb([row], captured));
    const got = await repo.loadOpen();
    expect(captured[0].sql).toMatch(/WHERE status = 'OPEN'/);
    expect(got).toHaveLength(1);
    expect(got[0].notionalUnits).toBe(500_000_000n);
    expect(got[0].capitalUnits).toBe(1_000_000_000n);
    expect(got[0].beta).toBeCloseTo(0.85, 6);
    expect(got[0].state.realisedPnlUnits).toBe('15832000');
    expect(got[0].state.open?.side).toBe('LONG');
  });

  it('markClosed sets status=CLOSED for the book_key', async () => {
    const captured: Captured[] = [];
    const repo = new StatArbStateRepository(makeFakeDb([], captured));
    await repo.markClosed('ETH/BTC');
    expect(captured[0].sql).toMatch(/UPDATE stat_arb_book_state SET status = 'CLOSED'/);
    expect(captured[0].params).toEqual(['ETH/BTC']);
  });
});

describe('NullStatArbStateStore', () => {
  it('is disabled and a no-op', async () => {
    const { NullStatArbStateStore } = await import('./null-stat-arb-state-store');
    const store = new NullStatArbStateStore();
    expect(store.enabled).toBe(false);
    await store.save(sample());
    expect(await store.loadOpen()).toEqual([]);
    await store.close('ETH/BTC'); // does not throw
  });
});
