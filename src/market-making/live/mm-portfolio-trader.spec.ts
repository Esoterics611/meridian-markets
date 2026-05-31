import { MmPortfolioTrader, MmBookSpec } from './mm-portfolio-trader';
import { MmBook } from './mm-book';
import { Bar } from '../../stat-arb/backtest/bar';
import { SymmetricQuoter } from '../quote/symmetric-quoter';

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
