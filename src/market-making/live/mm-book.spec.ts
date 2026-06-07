import { MmBook, MmBookConfig } from './mm-book';
import { Bar } from '../../stat-arb/backtest/bar';
import { SymmetricQuoter } from '../quote/symmetric-quoter';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair } from '../quote/quote-pair';
import { IDeskEventSink } from '../events/desk-event-sink';
import { DeskEventInput } from '../events/desk-event';

// Records the QuoteContext it was handed (delegates the actual quote to a symmetric
// quoter so the return value is valid) — lets us assert what MmBook puts in the ctx.
class CapturingQuoter implements IQuoter {
  readonly familyId = 'capture';
  lastCtx?: QuoteContext;
  private readonly inner = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n });
  quote(ctx: QuoteContext, symbol: string): QuotePair {
    this.lastCtx = ctx;
    return this.inner.quote(ctx, symbol);
  }
}

class CapturingSink implements IDeskEventSink {
  readonly events: DeskEventInput[] = [];
  emit(e: DeskEventInput): void {
    this.events.push(e);
  }
}

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

  it('emits a business event on every fill (the operator sees each trade enter)', async () => {
    const sink = new CapturingSink();
    // long-only tape → the first fill opens a long, later fills add to it.
    const bars = Array.from({ length: 6 }, (_, i) => bar(i, 1.0, 1.0001, 0.999));
    const book = new MmBook({ ...cfg(bars), events: sink });
    await tickAll(book, 6);
    const fills = sink.events.filter((e) => e.kind === 'fill');
    expect(fills.length).toBe(book.snapshot().fills); // one event per fill, no double-count
    expect(fills[0].side).toBe('BUY');
    expect(fills[0].action).toBe('open');
    expect(fills[0].message).toContain('opened long');
    expect(fills.some((e) => e.action === 'add')).toBe(true);
  });

  it('serialize → restore is lossless and the restored book keeps trading (restart-safe)', async () => {
    const bars = (): Bar[] => Array.from({ length: 6 }, (_, i) => bar(i, 1.0, 1.0001, 0.999)); // long-only
    const orig = new MmBook({ ...cfg(bars()), fundingRatePerHour: 0.01 });
    await tickAll(orig, 6);
    const a = orig.snapshot();
    const state = orig.serializeState();
    expect(BigInt(state.book.inventoryUnits)).toBeGreaterThan(0n); // there is real state to carry

    // Rebuild a fresh book (as the module would on boot) and restore the state.
    const revived = new MmBook({ ...cfg(bars()), fundingRatePerHour: 0.01 });
    revived.restore(state);
    expect(revived.serializeState()).toEqual(state); // round-trip is exact

    // Mid-independent ledger numbers survive verbatim.
    const b = revived.snapshot();
    expect(b.realisedPnlUnits).toBe(a.realisedPnlUnits);
    expect(b.feesUnits).toBe(a.feesUnits);
    expect(b.fundingUnits).toBe(a.fundingUnits);
    expect(b.inventoryUnits).toBe(a.inventoryUnits);
    expect(b.maxDrawdownPct).toBe(a.maxDrawdownPct);
    expect(b.fills).toBe(a.fills);

    // …and it resumes trading from the carried-over position.
    await tickAll(revived, 3);
    expect(revived.snapshot().barsSeen).toBeGreaterThan(a.barsSeen);
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

  describe('F1 micro-price quote center', () => {
    const flatBars = [bar(0, 1.0, 1.0, 1.0), bar(1, 1.0, 1.0, 1.0), bar(2, 1.0, 1.0, 1.0), bar(3, 1.0, 1.0, 1.0)];

    it('passes the reference micro-price into the quote context as the center (F1 live)', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({ ...cfg(flatBars), quoter: q, referenceMicros: async () => 1_002_000n });
      await tickAll(book, 4);
      // mid is 1.0 (1_000_000) but the L2 micro-price is 1.002 — the book hands the
      // quoter the micro-price as the center, the mid only for spread width.
      expect(q.lastCtx?.referenceMicros).toBe(1_002_000n);
      expect(q.lastCtx?.midMicros).toBe(1_000_000n);
    });

    it('falls back to the bar mid (no referenceMicros) when no fair-value source is wired', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({ ...cfg(flatBars), quoter: q });
      await tickAll(book, 4);
      expect(q.lastCtx?.referenceMicros).toBeUndefined();
    });

    it('falls back to the mid when the L2 fetch fails or returns null (best-effort, never skips the tick)', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({ ...cfg(flatBars), quoter: q, referenceMicros: async () => null });
      await tickAll(book, 4);
      expect(q.lastCtx?.referenceMicros).toBeUndefined();
      expect(book.snapshot().barsSeen).toBe(4); // ticks still ran
    });
  });

  describe('directional bias (the axe) — ctx.bias from the bias source', () => {
    const flatBars = [bar(0, 1.0, 1.0, 1.0), bar(1, 1.0, 1.0, 1.0), bar(2, 1.0, 1.0, 1.0), bar(3, 1.0, 1.0, 1.0)];

    it('passes a VALIDATED bias into the context', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({
        ...cfg(flatBars),
        quoter: q,
        biasSource: { bias: () => ({ bias: 0.6, validated: true, reason: 'view' }) },
      });
      await tickAll(book, 4);
      expect(q.lastCtx?.bias).toBeCloseTo(0.6);
    });

    it('ZEROES an UNVALIDATED bias before it reaches the quoter (the OOS gate)', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({
        ...cfg(flatBars),
        quoter: q,
        biasSource: { bias: () => ({ bias: 0.9, validated: false, reason: 'unproven' }) },
      });
      await tickAll(book, 4);
      expect(q.lastCtx?.bias).toBe(0);
    });

    it('leaves ctx.bias undefined when no bias source is wired (neutral; nothing regresses)', async () => {
      const q = new CapturingQuoter();
      const book = new MmBook({ ...cfg(flatBars), quoter: q });
      await tickAll(book, 4);
      expect(q.lastCtx?.bias).toBeUndefined();
    });
  });
});
