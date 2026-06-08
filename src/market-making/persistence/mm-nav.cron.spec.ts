import { MmNavCron, navRowsFromSnapshot } from './mm-nav.cron';
import { ConfigService } from '@nestjs/config';
import { MmNavRepository, MmNavInsert } from './mm-nav.repository';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../live/mm-portfolio-trader';
import { MmBookSnapshot } from '../live/mm-book';

// Offline-first: a fake trader + repo. No DB, no network. The DB round-trip is
// covered by mm-nav.repository.int-spec.ts.

function book(over: Partial<MmBookSnapshot>): MmBookSnapshot {
  return {
    symbol: 'BTC', strategyId: 'mm-glft', source: 'hyperliquid', family: 'glft',
    running: true, warm: true, barsSeen: 10, seededBars: 90, lastBarAt: null,
    midMicros: '0', bidMicros: null, askMicros: null, reservationMicros: null, halfSpreadMicros: null,
    inventoryUnits: '0', capitalUnits: '50000000000', equityUnits: '50000000000',
    realisedPnlUnits: '0', unrealisedPnlUnits: '0', feesUnits: '0', fundingUnits: '0', fundingRatePerHour: 0,
    netPnlUnits: '0', spreadCapturedUnits: '0', adverseSelectionUnits: '0',
    inventoryCarryUnits: '0', inventoryNotionalCapUnits: '0', vpin: 0, vpinBuckets: 0, markout: [],
    fills: 0, bidFills: 0, askFills: 0, blockedQuotes: 0, lastVerdict: 'Allow', maxDrawdownPct: 0,
    ...over,
  };
}

function snapshot(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: true, bookCount: 0, capitalUnits: '100000000000', equityUnits: '100000000000',
    realisedPnlUnits: '0', unrealisedPnlUnits: '0', feesUnits: '0', fundingUnits: '0',
    netPnlUnits: '0', books: [],
    ...over,
  };
}

function trader(s: MmPortfolioSnapshot): MmPortfolioTrader {
  return { snapshot: () => s } as unknown as MmPortfolioTrader;
}

function cfg(nodeEnv = 'test', navIntervalMs = 60_000): ConfigService {
  return { getOrThrow: () => ({ nodeEnv, marketMaking: { navIntervalMs } }) } as unknown as ConfigService;
}

describe('navRowsFromSnapshot (pure mapping)', () => {
  it('emits a desk row whose equity equals snapshot.equityUnits (the §8 NAV identity)', () => {
    const s = snapshot({ equityUnits: '100000345000', netPnlUnits: '345000', bookCount: 1, books: [book({})] });
    const rows = navRowsFromSnapshot(s, new Date('2026-06-04T00:00:00Z'));
    const desk = rows[0];
    expect(desk.bookKey).toBe('');
    // This is the same number MetricsCollector writes to meridian_desk_nav_units.
    expect(desk.equityUnits).toBe(BigInt(s.equityUnits));
    expect(desk.netPnlUnits).toBe(345_000n);
  });

  it('emits one row per book keyed by symbol, plus the desk row', () => {
    const s = snapshot({
      bookCount: 2,
      books: [
        book({ symbol: 'BTC', equityUnits: '50000100000', inventoryUnits: '791600', maxDrawdownPct: 0.5 }),
        book({ symbol: 'ETH', equityUnits: '50000050000', inventoryUnits: '-200000', maxDrawdownPct: 1.2 }),
      ],
    });
    const rows = navRowsFromSnapshot(s, new Date());
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.bookKey)).toEqual(['', 'BTC', 'ETH']);
    expect(rows[1].equityUnits).toBe(50_000_100_000n);
    expect(rows[1].inventoryUnits).toBe(791_600n);
  });

  it('desk inventory sums the books and desk drawdown takes the worst', () => {
    const s = snapshot({
      bookCount: 2,
      books: [
        book({ symbol: 'BTC', inventoryUnits: '791600', maxDrawdownPct: 0.5 }),
        book({ symbol: 'ETH', inventoryUnits: '-200000', maxDrawdownPct: 1.2 }),
      ],
    });
    const desk = navRowsFromSnapshot(s, new Date())[0];
    expect(desk.inventoryUnits).toBe(591_600n);
    expect(desk.maxDrawdownPct).toBeCloseTo(1.2);
  });

  it('emits a single desk row (equity = capital) for an empty desk', () => {
    const rows = navRowsFromSnapshot(snapshot(), new Date());
    expect(rows).toHaveLength(1);
    expect(rows[0].equityUnits).toBe(100_000_000_000n);
  });
});

describe('MmNavCron', () => {
  it('tick() writes the rows derived from the live snapshot', async () => {
    let written: MmNavInsert[] | null = null;
    const repo = { insertNavSnapshot: async (rows: MmNavInsert[]) => { written = rows; return rows.length; } } as unknown as MmNavRepository;
    const s = snapshot({ equityUnits: '100000999000', bookCount: 1, books: [book({ symbol: 'BTC', equityUnits: '50000999000' })] });
    const cron = new MmNavCron(cfg(), trader(s), repo);
    await cron.tick(new Date('2026-06-04T12:00:00Z'));
    expect(written).not.toBeNull();
    expect(written!).toHaveLength(2);
    expect(written![0].bookKey).toBe('');
    expect(written![0].equityUnits).toBe(100_000_999_000n);
    expect(written![0].asOf).toEqual(new Date('2026-06-04T12:00:00Z'));
  });

  it('is a no-op when the repo is null (MM_PERSIST off / no DB)', async () => {
    const cron = new MmNavCron(cfg(), trader(snapshot()), null);
    await expect(cron.tick()).resolves.toBeUndefined();
  });

  it('swallows + logs repo errors (a NAV write never crashes the loop)', async () => {
    const repo = { insertNavSnapshot: async () => { throw new Error('boom'); } } as unknown as MmNavRepository;
    await expect(new MmNavCron(cfg(), trader(snapshot()), repo).tick()).resolves.toBeUndefined();
  });

  it('onModuleInit does not start a timer when the repo is null', () => {
    const cron = new MmNavCron(cfg('development'), trader(snapshot()), null);
    cron.onModuleInit();
    expect((cron as unknown as { handle: NodeJS.Timeout | null }).handle).toBeNull();
  });

  it('onModuleInit skips the timer under nodeEnv=test even with a repo', () => {
    const repo = { insertNavSnapshot: async () => 1 } as unknown as MmNavRepository;
    const cron = new MmNavCron(cfg('test'), trader(snapshot()), repo);
    cron.onModuleInit();
    expect((cron as unknown as { handle: NodeJS.Timeout | null }).handle).toBeNull();
  });
});
