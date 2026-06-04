import { MmBook, MmBookConfig } from './mm-book';
import { Bar } from '../../stat-arb/backtest/bar';
import { SymmetricQuoter } from '../quote/symmetric-quoter';

function bar(i: number, close: number, high: number, low: number): Bar {
  return { symbol: 'USDC', timestamp: new Date(2026, 0, 1, 0, i), open: close, high, low, close, volume: 1000 };
}

function feedOf(bars: Bar[]): (symbol: string) => Promise<Bar | null> {
  let idx = 0;
  return async () => (idx < bars.length ? bars[idx++] : null);
}

function cfg(bars: Bar[]): MmBookConfig {
  return {
    symbol: 'USDC',
    strategyId: 'mm-symmetric',
    quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }),
    quoteSizeUnits: 1_000_000n,
    gamma: 0.0025,
    kappa: 2,
    horizonBars: 1,
    volWindowBars: 2,
    volFloor: 0.0001,
    makerFeeBps: 0,
    capitalUnits: 1_000_000_000n,
    nextBar: feedOf(bars),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

async function tickAll(book: MmBook, n: number) {
  for (let i = 0; i < n; i++) await book.tick();
}

describe('MmBook', () => {
  it('warms up, then captures the spread on a straddling tape with balanced inventory', async () => {
    const bars = Array.from({ length: 6 }, (_, i) => bar(i, 1.0, 1.001, 0.999));
    const book = new MmBook(cfg(bars));
    await tickAll(book, 6);
    const s = book.snapshot();
    expect(s.warm).toBe(true);
    expect(s.fills).toBeGreaterThan(0);
    expect(s.bidFills).toBe(s.askFills); // straddle → balanced
    expect(BigInt(s.inventoryUnits)).toBe(0n);
    expect(s.bidMicros).not.toBeNull();
  });

  it('accumulates inventory on a one-sided tape and flatten() clears it', async () => {
    // low reaches the bid (we buy), high never reaches the ask → long-only.
    const bars = Array.from({ length: 6 }, (_, i) => bar(i, 1.0, 1.0001, 0.999));
    const book = new MmBook(cfg(bars));
    await tickAll(book, 6);
    expect(BigInt(book.snapshot().inventoryUnits)).toBeGreaterThan(0n);
    await book.flatten();
    expect(BigInt(book.snapshot().inventoryUnits)).toBe(0n);
  });

  it('accrues funding on held inventory (long pays a positive rate), folded into net + equity', async () => {
    const longBars = (): Bar[] => Array.from({ length: 6 }, (_, i) => bar(i, 1.0, 1.0001, 0.999));
    const noF = new MmBook(cfg(longBars()));
    await tickAll(noF, 6);
    const withF = new MmBook({ ...cfg(longBars()), fundingRatePerHour: 0.01 }); // + ⇒ longs pay
    await tickAll(withF, 6);

    const a = noF.snapshot();
    const b = withF.snapshot();
    expect(a.fundingUnits).toBe('0'); // default off
    expect(BigInt(b.inventoryUnits)).toBeGreaterThan(0n); // net long
    expect(BigInt(b.fundingUnits)).toBeLessThan(0n); // long pays a positive rate
    // funding is the ONLY difference vs the no-funding run (fills are identical).
    expect(BigInt(b.netPnlUnits)).toBe(BigInt(a.netPnlUnits) + BigInt(b.fundingUnits));
    expect(BigInt(b.equityUnits)).toBe(BigInt(a.equityUnits) + BigInt(b.fundingUnits));
  });

  it('no-ops a tick when the feed has no new bar', async () => {
    const book = new MmBook(cfg([]));
    await book.tick();
    expect(book.snapshot().barsSeen).toBe(0);
  });
});
