import { MmNavCron, navRowsFromSnapshot, f3Summary, findInsaneMark } from './mm-nav.cron';
import { ConfigService } from '@nestjs/config';
import { MmNavRepository, MmNavInsert } from './mm-nav.repository';
import { MmResearchRepository } from './mm-research.repository';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../live/mm-portfolio-trader';
import { MmBookSnapshot } from '../live/mm-book';
import { HedgeSnapshot } from '../hedge/desk-hedge-controller';

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
    inventoryCarryUnits: '0', inventoryMtmUnits: '0', inventoryNotionalCapUnits: '0', vpin: 0, vpinBuckets: 0, vpinWindowBuckets: 50, markout: [], markoutBySide: { buy: [], sell: [] },
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

describe('f3Summary (DR-3 grep-able toxicity line)', () => {
  it('summarises each book that carries the F3 scaler; null when none do', () => {
    expect(f3Summary(snapshot({ books: [book({ symbol: 'BTC' })] }))).toBeNull(); // no toxicity ⇒ no line
    const s = snapshot({
      books: [
        book({ symbol: 'BTC', toxicity: { widenSteps: 12, tightenSteps: 340, avgScale: 0.71, maxScale: 2.43, lastScale: 0.6 } }),
        book({ symbol: 'ETH' }), // bar-ish / no scaler ⇒ skipped
      ],
    });
    const line = f3Summary(s);
    expect(line).toBe('BTC widen=12 tighten=340 avg=0.71 max=2.43 last=0.60');
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

// F0 corrupt-mark guard (run55 worst5m root cause): a mark whose |unreal| exceeds the book's
// own capital is a garbage mid, and the whole interval is skipped — never persisted.
describe('findInsaneMark + the tick() guard', () => {
  it('is null for a sane snapshot, names the offender beyond its capital', () => {
    expect(findInsaneMark(snapshot({ books: [book({})] }))).toBeNull();
    const bad = snapshot({
      books: [book({}), book({ symbol: 'kPEPE', capitalUnits: '1000000000000', unrealisedPnlUnits: '-3033717000000' })],
    });
    expect(findInsaneMark(bad)).toMatch(/kPEPE.*-3033717.*exceeds capital.*1000000/);
  });

  it('tick() SKIPS the interval (no rows written) on an insane mark', async () => {
    let writes = 0;
    const repo = { insertNavSnapshot: async () => ((writes += 1), 1) } as unknown as MmNavRepository;
    const bad = snapshot({ books: [book({ capitalUnits: '1000000', unrealisedPnlUnits: '-2000000' })] });
    await new MmNavCron(cfg(), trader(bad), repo).tick();
    expect(writes).toBe(0);
  });
});

// F0 hedge persistence (DR-2 closure): per-leg P&L every interval, quality hourly + shutdown.
describe('MmNavCron — hedge research writes', () => {
  const hedgeSnap: HedgeSnapshot = {
    enabled: true,
    grossDeltaUsd: 1000,
    residualUsd: 50,
    hedgePnlUsd: -3,
    hedgeCostUsd: 1,
    fundingUsd: 0.5,
    perUnderlying: [
      { underlying: 'ETH', netDeltaUsd: -900, hedgeUnits: 0.3, hedgeNotionalUsd: 850, residualUsd: -50, markUsd: 2800, pnlUsd: -3, fundingUsd: 0.5, feesUsd: 1 },
    ],
    ordersLastTick: [],
    quality: { perBook: [{ symbol: 'SOL', underlying: 'ETH', betaCfg: 1.1, betaLive: 1.0, r2: 0.8, basisShare: 0.3, pnlVolUsdPerHour: 4 }] },
  } as unknown as HedgeSnapshot;

  function research(): { navWrites: number; qualityWrites: number; repo: MmResearchRepository } {
    const calls = { navWrites: 0, qualityWrites: 0, repo: null as unknown as MmResearchRepository };
    calls.repo = {
      insertHedgeNav: async () => ((calls.navWrites += 1), 1),
      insertHedgeQuality: async () => ((calls.qualityWrites += 1), 1),
    } as unknown as MmResearchRepository;
    return calls;
  }

  it('writes hedge legs every interval but quality only on the hourly cadence', async () => {
    const navRepo = { insertNavSnapshot: async () => 1 } as unknown as MmNavRepository;
    const r = research();
    const cron = new MmNavCron(cfg(), trader(snapshot({ hedge: hedgeSnap })), navRepo, r.repo);
    await cron.tick(new Date('2026-06-12T10:00:00Z'));
    await cron.tick(new Date('2026-06-12T10:01:00Z')); // < 1h later — no second quality row
    await cron.tick(new Date('2026-06-12T11:00:30Z')); // past the hour — quality again
    expect(r.navWrites).toBe(3);
    expect(r.qualityWrites).toBe(2);
  });

  it('onModuleDestroy writes a final hedge quality + nav row (the shutdown audit)', async () => {
    const r = research();
    const cron = new MmNavCron(cfg(), trader(snapshot({ hedge: hedgeSnap })), null, r.repo);
    await cron.onModuleDestroy();
    expect(r.qualityWrites).toBe(1);
    expect(r.navWrites).toBe(1);
  });

  it('no hedge in the snapshot ⇒ no research writes', async () => {
    const navRepo = { insertNavSnapshot: async () => 1 } as unknown as MmNavRepository;
    const r = research();
    const cron = new MmNavCron(cfg(), trader(snapshot()), navRepo, r.repo);
    await cron.tick();
    await cron.onModuleDestroy();
    expect(r.navWrites + r.qualityWrites).toBe(0);
  });
});

// F2 (Journal #61): the grep-able per-interval requote/taker line.
describe('f2Summary (F2 requote + taker-cross line)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { f2Summary } = require('./mm-nav.cron');

  it('is null when no book carries requote counters or taker crosses', () => {
    expect(f2Summary(snapshot({ books: [book({})] }))).toBeNull();
  });

  it('renders moves/holds + per-trigger taker fees per book', () => {
    const s = snapshot({
      books: [
        book({
          symbol: 'SOL',
          requote: { moves: 120, hysteresisHolds: 3400, dwellHolds: 80 },
          takerCrosses: { 'loss-stop': { count: 2, feeUnits: '5000000', notionalUnits: '100000000000' } },
        }),
        book({ symbol: 'BTC' }), // nothing to report ⇒ skipped
      ],
    });
    expect(f2Summary(s)).toBe('SOL moves=120 holdH=3400 holdD=80 taker[loss-stop×2=$5]');
  });
});
