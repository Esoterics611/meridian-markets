import { MmStateRepository } from './mm-state.repository';
import { MmBookRecord } from './mm-state-store.interface';
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

const sample = (): MmBookRecord => ({
  bookKey: 'BTC',
  symbol: 'BTC',
  source: 'hyperliquid',
  strategyId: 'mm-glft',
  params: { gamma: 0.0025 },
  gamma: 0.0025,
  kappa: 2,
  horizonBars: 1,
  volWindowBars: 20,
  volFloor: 0.0001,
  makerFeeBps: -0.2,
  fundingRatePerHour: 0.0000125,
  quoteSizeUnits: 791_600n,
  capitalUnits: 1_000_000_000n,
  running: true,
  state: {
    book: { inventoryUnits: '791600', avgCostMicros: '63156000000', realisedUnits: '15832000', feesUnits: '-2000000', fillCount: 2 },
    fundingUnits: '-625004',
    spreadCapturedUnits: '7916000',
    adverseUnits: '0',
    peakEquityUnits: '1000017200',
    maxDrawdownPct: 0.01,
    barsSeen: 240,
    fills: 2,
    bidFills: 1,
    askFills: 1,
    blockedQuotes: 0,
  },
});

describe('MmStateRepository (unit)', () => {
  it('upsert sends an INSERT … ON CONFLICT with bigints as strings + JSONB blobs', async () => {
    const captured: Captured[] = [];
    const repo = new MmStateRepository(makeFakeDb([], captured));
    await repo.upsert(sample());
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toMatch(/INSERT INTO mm_book_state/);
    expect(captured[0].sql).toMatch(/ON CONFLICT \(book_key\) DO UPDATE/);
    const p = captured[0].params;
    expect(p[0]).toBe('BTC'); // book_key
    expect(p[12]).toBe('791600'); // quote_size_units as string
    expect(p[13]).toBe('1000000000'); // capital_units as string
    expect(p[4]).toBe(JSON.stringify({ gamma: 0.0025 })); // params JSONB
    expect(p[15]).toContain('"inventoryUnits":"791600"'); // state JSONB blob
  });

  it('loadOpen filters status=OPEN and coerces bigints back from strings', async () => {
    const captured: Captured[] = [];
    const row: FakeRow = {
      book_key: 'BTC', symbol: 'BTC', source: 'hyperliquid', strategy_id: 'mm-glft',
      params: { gamma: 0.0025 }, gamma: 0.0025, kappa: 2, horizon_bars: 1,
      vol_window_bars: 20, vol_floor: 0.0001, maker_fee_bps: -0.2, funding_rate_per_hour: 0.0000125,
      quote_size_units: '791600', capital_units: '1000000000', running: true,
      state: sample().state,
    };
    const repo = new MmStateRepository(makeFakeDb([row], captured));
    const got = await repo.loadOpen();
    expect(captured[0].sql).toMatch(/WHERE status = 'OPEN'/);
    expect(got).toHaveLength(1);
    expect(got[0].quoteSizeUnits).toBe(791_600n);
    expect(got[0].capitalUnits).toBe(1_000_000_000n);
    expect(got[0].state.book.inventoryUnits).toBe('791600');
    expect(got[0].fundingRatePerHour).toBeCloseTo(0.0000125, 12);
  });

  it('markClosed sets status=CLOSED for the book_key', async () => {
    const captured: Captured[] = [];
    const repo = new MmStateRepository(makeFakeDb([], captured));
    await repo.markClosed('BTC');
    expect(captured[0].sql).toMatch(/UPDATE mm_book_state SET status = 'CLOSED'/);
    expect(captured[0].params).toEqual(['BTC']);
  });
});
