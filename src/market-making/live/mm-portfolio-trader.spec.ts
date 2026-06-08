import { MmPortfolioTrader, MmBookSpec } from './mm-portfolio-trader';
import { MmBook } from './mm-book';
import { Bar } from '../../stat-arb/backtest/bar';
import { SymmetricQuoter } from '../quote/symmetric-quoter';
import { IMmStateStore, MmBookRecord } from '../persistence/mm-state-store.interface';
import { DeskHedgeController } from '../hedge/desk-hedge-controller';
import { PaperVenue } from '../../execution/paper-venue';

function bars(symbol: string): Bar[] {
  return Array.from({ length: 6 }, (_, i) => ({
    symbol,
    timestamp: new Date(2026, 0, 1, 0, i),
    open: 1.0,
    high: 1.001,
    low: 0.999,
    close: 1.0,
    volume: 1000,
  }));
}

function makeBook(spec: MmBookSpec): MmBook {
  const data = bars(spec.symbol);
  let idx = 0;
  return new MmBook({
    symbol: spec.symbol,
    strategyId: spec.strategyId ?? 'mm-symmetric',
    quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }),
    quoteSizeUnits: 1_000_000n,
    gamma: 0.0025,
    kappa: 2,
    horizonBars: 1,
    volWindowBars: 2,
    volFloor: 0.0001,
    makerFeeBps: 0,
    capitalUnits: 1_000_000_000n,
    nextBar: async () => (idx < data.length ? data[idx++] : null),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
}

// An in-memory IMmStateStore for the restart-safe-books test.
function makeFakeStore() {
  const saved = new Map<string, MmBookRecord>();
  const closed: string[] = [];
  const store: IMmStateStore = {
    enabled: true,
    save: async (r) => void saved.set(r.bookKey, r),
    loadOpen: async () => [...saved.values()].filter((r) => !closed.includes(r.bookKey)),
    close: async (k) => void closed.push(k),
  };
  return { store, saved, closed };
}

function rebuildBook(rec: MmBookRecord): Promise<MmBook> {
  const data = bars(rec.symbol);
  let idx = 0;
  return Promise.resolve(
    new MmBook({
      symbol: rec.symbol,
      strategyId: rec.strategyId,
      quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: rec.quoteSizeUnits }),
      quoteSizeUnits: rec.quoteSizeUnits,
      gamma: rec.gamma,
      kappa: rec.kappa,
      horizonBars: rec.horizonBars,
      volWindowBars: rec.volWindowBars,
      volFloor: rec.volFloor,
      makerFeeBps: rec.makerFeeBps,
      fundingRatePerHour: rec.fundingRatePerHour,
      capitalUnits: rec.capitalUnits,
      nextBar: async () => (idx < data.length ? data[idx++] : null),
      now: () => new Date('2026-01-01T00:00:00Z'),
    }),
  );
}

describe('MmPortfolioTrader', () => {
  it('launches isolated books, ticks them, and aggregates a snapshot', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000, 2_000_000_000n);
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n);
    await pf.addBook({ symbol: 'FDUSD' }, 1_000_000_000n);
    for (let i = 0; i < 6; i++) await pf.tick();

    const snap = pf.snapshot();
    expect(snap.bookCount).toBe(2);
    expect(snap.books.map((b) => b.symbol).sort()).toEqual(['FDUSD', 'USDC']);
    expect(snap.books.every((b) => b.fills > 0)).toBe(true);
  });

  it('delta hedge: undefined by default (snapshot.hedge absent, behaviour unchanged)', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000, 2_000_000_000n);
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n);
    await pf.tick();
    expect(pf.snapshot().hedge).toBeUndefined();
  });

  it('delta hedge: when wired, flattens each book net delta on the perp leg after a tick', async () => {
    const hedgeMids: Record<string, bigint> = {};
    const venue = new PaperVenue({ pricePoller: async (s) => hedgeMids[s] ?? 0n, takerFeeBps: 3n });
    const hedger = new DeskHedgeController(
      venue,
      { bandUsd: 0, betaMap: {}, hedgeTakerBps: 2.5, hedgeHalfSpreadBps: 1 },
      () => new Date(),
      (p) => Object.assign(hedgeMids, p),
    );
    const pf = new MmPortfolioTrader(makeBook, 1000, 2_000_000_000n, {}, undefined, undefined, hedger);
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n);
    for (let i = 0; i < 6; i++) await pf.tick();

    const snap = pf.snapshot();
    expect(snap.hedge?.enabled).toBe(true);
    // With a zero band, any net delta is hedged out ⇒ residual ≈ flat (sub-dollar rounding).
    expect(snap.hedge!.residualUsd).toBeLessThan(1);
    // The hedge mirrors the book's net delta in size.
    const inv = Number(BigInt(snap.books[0].inventoryUnits)) / 1e6;
    expect(snap.hedge!.grossDeltaUsd).toBeCloseTo(Math.abs(inv * 1.0), 4);
  });

  it('refreshFunding drives the source per (symbol, source) and counts only updated books', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000, 3_000_000_000n);
    await pf.addBook({ symbol: 'BTC', source: 'hyperliquid' }, 1_000_000_000n);
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n); // no source ⇒ spot, returns null (unchanged)

    const calls: Array<[string, string | undefined]> = [];
    const updated = await pf.refreshFunding(async (symbol, source) => {
      calls.push([symbol, source]);
      return source === 'hyperliquid' ? 0.0000125 : null; // perp → rate; spot → leave as-is
    });

    expect(calls).toContainEqual(['BTC', 'hyperliquid']);
    expect(calls).toContainEqual(['USDC', undefined]);
    expect(updated).toBe(1); // only the HL book got a (non-null) rate
  });

  it('refreshFunding is best-effort: one book throwing does not abort the sweep', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000, 3_000_000_000n);
    await pf.addBook({ symbol: 'BTC', source: 'hyperliquid' }, 1_000_000_000n);
    await pf.addBook({ symbol: 'ETH', source: 'hyperliquid' }, 1_000_000_000n);

    const updated = await pf.refreshFunding(async (symbol) => {
      if (symbol === 'BTC') throw new Error('HL down');
      return 0.00002;
    });

    expect(updated).toBe(1); // ETH still updated despite BTC throwing
  });

  it('checkpoints books and rehydrates inventory + P&L on a fresh trader (restart-safe)', async () => {
    const { store, saved, closed } = makeFakeStore();
    const a = new MmPortfolioTrader(makeBook, 1000, 2_000_000_000n, { store, rebuildBook });
    await a.addBook({ symbol: 'USDC', strategyId: 'mm-symmetric' }, 1_000_000_000n);
    for (let i = 0; i < 6; i++) await a.tick();
    expect(saved.has('USDC')).toBe(true);
    const persistedFills = saved.get('USDC')!.state.fills;
    expect(persistedFills).toBeGreaterThan(0); // real state was checkpointed

    // Simulate a restart: a brand-new trader over the SAME store rehydrates on boot.
    const b = new MmPortfolioTrader(makeBook, 1000, 2_000_000_000n, { store, rebuildBook });
    await b.onApplicationBootstrap();
    const snap = b.snapshot();
    expect(snap.bookCount).toBe(1);
    expect(snap.books[0].symbol).toBe('USDC');
    expect(snap.books[0].fills).toBe(persistedFills); // P&L state carried across restart

    // removeBook soft-closes the row (kept, not deleted) so its final P&L survives.
    await b.removeBook('USDC');
    expect(closed).toContain('USDC');
  });

  it('does not persist when the store is disabled (default Null) — no behaviour change', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000); // no persistence opts ⇒ NullStore
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n);
    await pf.tick();
    expect(pf.snapshot().bookCount).toBe(1); // works exactly as before
  });

  it('removes one book and stops when the last is removed', async () => {
    const pf = new MmPortfolioTrader(makeBook, 1000);
    await pf.addBook({ symbol: 'USDC' }, 1_000_000_000n);
    pf.start();
    expect(pf.isRunning()).toBe(true);
    expect(await pf.removeBook('USDC')).toBe(true);
    expect(pf.snapshot().bookCount).toBe(0);
    expect(pf.isRunning()).toBe(false);
    pf.stop();
  });
});
