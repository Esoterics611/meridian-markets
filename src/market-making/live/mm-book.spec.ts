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

  describe('fast L2 path coexistence (C2)', () => {
    it('a fast-path book IGNORES the bar tick (no double-counting) and reports isFastPath', async () => {
      const { L2LiveFillEngine } = await import('./l2-live-fill-engine');
      const eng = new L2LiveFillEngine({
        symbol: 'BTC',
        quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }),
        quoteSizeUnits: 1_000_000n,
        gamma: 0.0025,
        kappa: 2,
        horizonBars: 1,
        volWindowBars: 2,
        volFloor: 0.0001,
        makerFeeBps: -0.2,
        capitalUnits: 1_000_000_000n,
        microDepth: 5,
        cancelReplaceLatencyMs: 100,
      });
      const book = new MmBook({ ...cfg([bar(0, 1, 1, 1), bar(1, 1, 1, 1)]), symbol: 'BTC', fastEngine: eng });
      book.setRunning(true);
      expect(book.isFastPath()).toBe(true);
      // bars are queued, but the fast path must never consume them (the trader skips
      // fast-path books in the bar loop; tick() is also a self-guarded no-op).
      await book.tick();
      await book.tick();
      const snap = book.snapshot();
      expect(snap.barsSeen).toBe(0); // no bar consumed; snapshot reads the engine (0 L2 snapshots)
      expect(snap.fundingUnits).toBe('0');
    });
  });

  describe('fast L2 path — directional bias', () => {
    it('the fast engine applies a VALIDATED bias to its quote center (BTC funding tilt on C2)', async () => {
      const { L2LiveFillEngine } = await import('./l2-live-fill-engine');
      const capture = new CapturingQuoter();
      const eng = new L2LiveFillEngine({
        symbol: 'BTC',
        quoter: capture,
        quoteSizeUnits: 1_000_000n,
        gamma: 0.0025,
        kappa: 2,
        horizonBars: 1,
        volWindowBars: 2,
        volFloor: 0.0001,
        makerFeeBps: -0.2,
        capitalUnits: 1_000_000_000n,
        biasSource: { bias: () => ({ bias: 0.39, validated: true, reason: 'funding' }) },
      });
      const lvl = (p: bigint, s: bigint) => ({ priceMicros: p, sizeUnits: s, orderCount: 1 });
      const snap = (ts: number) => ({ snapshot: { symbol: 'BTC', ts: new Date(ts), bids: [lvl(100_000_000n, 5_000_000n)], asks: [lvl(100_100_000n, 5_000_000n)] } });
      // warm the engine (volWindowBars=2) then one more snapshot to quote
      eng.onSnapshot(snap(0));
      eng.onSnapshot(snap(1000));
      eng.onSnapshot(snap(2000));
      expect(capture.lastCtx?.bias).toBeCloseTo(0.39);
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

// S1 (Journal #49/#51): the attribution identity. The 4-component split marked drift only inside
// post-fill markout windows, so P&L on warehoused inventory between fills landed in NO component
// and "components vs net" diverged by $thousands per run. inventoryMtmUnits is the continuous
// warehouse term (accrueInterval: inv_carried × Δmid, every interval). The identity it restores:
//   net = spreadCaptured + inventoryMtm + funding − fees   (exact up to integer rounding)
describe('attribution identity — net = spread + inventoryMtm + funding − fees (S1)', () => {
  it('reconciles exactly on a fill-then-slide tape (warehouse drift outside any markout window)', async () => {
    const bars: Bar[] = [
      // warmup
      bar(0, 1.0, 1.0, 1.0),
      bar(1, 1.0, 1.0, 1.0),
      // one-sided fills: low touches the bid each bar → the book accumulates a long
      bar(2, 1.0, 1.0001, 0.999),
      bar(3, 1.0, 1.0001, 0.999),
      bar(4, 1.0, 1.0001, 0.999),
      // the slide: price walks down 5% with a range too narrow to fill — pure warehouse drift
      bar(5, 0.98, 0.9801, 0.9799),
      bar(6, 0.96, 0.9601, 0.9599),
      bar(7, 0.95, 0.9501, 0.9499),
    ];
    const book = new MmBook({ ...cfg(bars), makerFeeBps: 1, fundingRatePerHour: 0.0005 });
    await tickAll(book, bars.length);
    const s = book.snapshot();

    expect(BigInt(s.inventoryUnits)).toBeGreaterThan(0n); // long was warehoused
    const net = BigInt(s.netPnlUnits);
    const spread = BigInt(s.spreadCapturedUnits);
    const invMtm = BigInt(s.inventoryMtmUnits);
    const funding = BigInt(s.fundingUnits);
    const fees = BigInt(s.feesUnits);

    // The slide happened with no fills, so the drift is invisible to per-fill windows — the old
    // gap. The continuous term must carry it (a loss roughly the inventory × the 5% slide).
    expect(invMtm).toBeLessThan(0n);

    // The identity: components reconcile to net within integer-division rounding (≪ $1).
    const reconstructed = spread + invMtm + funding - fees;
    const diff = net - reconstructed;
    const tol = BigInt(bars.length + s.fills + 2); // 1 unit ($1e-6) per integer division
    expect(diff <= tol && diff >= -tol).toBe(true);
  });

  it('funding=0 / fee-rebate variant still reconciles (sign conventions hold)', async () => {
    const bars: Bar[] = [
      bar(0, 1.0, 1.0, 1.0),
      bar(1, 1.0, 1.0, 1.0),
      bar(2, 1.0, 1.001, 0.999), // straddle: both sides fill, inventory nets out
      bar(3, 1.0, 1.001, 0.999),
      bar(4, 1.02, 1.0201, 1.0199), // drift with whatever inventory remains
    ];
    const book = new MmBook({ ...cfg(bars), makerFeeBps: -0.2 }); // rebate ⇒ feesUnits negative
    await tickAll(book, bars.length);
    const s = book.snapshot();
    const net = BigInt(s.netPnlUnits);
    const reconstructed = BigInt(s.spreadCapturedUnits) + BigInt(s.inventoryMtmUnits) + BigInt(s.fundingUnits) - BigInt(s.feesUnits);
    const diff = net - reconstructed;
    const tol = BigInt(bars.length + s.fills + 2);
    expect(diff <= tol && diff >= -tol).toBe(true);
  });
});

describe('fast-path windowed attribution survives a restore (S2 — the S1 leak-table gap)', () => {
  it('restore loads spread/adverse as a baseline and serializeState re-emits it (engine fresh at 0)', async () => {
    const { L2LiveFillEngine } = await import('./l2-live-fill-engine');
    const mkEng = () =>
      new L2LiveFillEngine({
        symbol: 'BTC',
        quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }),
        quoteSizeUnits: 1_000_000n,
        gamma: 0.0025,
        kappa: 2,
        horizonBars: 1,
        volWindowBars: 2,
        volFloor: 0.0001,
        makerFeeBps: -0.2,
        capitalUnits: 1_000_000_000n,
        microDepth: 5,
        cancelReplaceLatencyMs: 100,
      });
    const a = new MmBook({ ...cfg([]), symbol: 'BTC', fastEngine: mkEng() });
    const state = a.serializeState();
    state.spreadCapturedUnits = '5000000'; // $5 earned before the restart
    state.adverseUnits = '2000000';
    state.windowedCarryUnits = '1000000';
    const b = new MmBook({ ...cfg([]), symbol: 'BTC', fastEngine: mkEng() });
    b.restore(state);
    const snap = b.snapshot();
    expect(snap.spreadCapturedUnits).toBe('5000000'); // baseline shows though the engine is fresh
    expect(snap.adverseSelectionUnits).toBe('2000000');
    const reserialized = b.serializeState();
    expect(reserialized.spreadCapturedUnits).toBe('5000000'); // and survives the next checkpoint
    expect(reserialized.windowedCarryUnits).toBe('1000000');
  });
});

// Journal #55 guardrails — the warehouse loss-stop + the session gate. Bar-path coverage
// (deterministic scripted tape); the fast path shares guardrail() and pulls quotes via
// the engine's cancelResting() (covered by the unit below + the shared method).
describe('guardrails (#55) — warehouse loss-stop + session gate', () => {
  const utcBar = (minute: number, close: number, high: number, low: number): Bar => ({
    symbol: 'USDC',
    timestamp: new Date(Date.UTC(2026, 0, 1, 14, minute)), // 14:xx UTC — inside US RTH
    open: close,
    high,
    low,
    close,
    volume: 1000,
  });

  it('loss-stop: flattens the warehouse at taker + stands aside through the cooldown', async () => {
    const sink = new CapturingSink();
    // 6 long-only bars build inventory, then a crash bar marks it deeply underwater
    // (no fills on the crash bar — the range is away from the resting quotes), then
    // 2 more bars inside the cooldown that WOULD fill if the book were quoting.
    const tape = [
      ...Array.from({ length: 6 }, (_, i) => utcBar(i, 1.0, 1.0001, 0.999)),
      utcBar(6, 0.9, 0.9001, 0.8999),
      utcBar(7, 0.9, 0.91, 0.89),
      utcBar(8, 0.9, 0.91, 0.89),
    ];
    // capital $1000; stop at 0.01% = $0.1 — ~4 units long × −$0.10 ⇒ breached at the crash.
    const book = new MmBook({ ...cfg(tape), lossStopFrac: 0.0001, lossStopCooldownMs: 15 * 60_000, events: sink });
    await tickAll(book, 6);
    const invBefore = BigInt(book.snapshot().inventoryUnits);
    expect(invBefore).toBeGreaterThan(0n);
    const fillsBefore = book.snapshot().fills;

    await book.tick(); // the crash bar → guardrail fires
    const s = book.snapshot();
    expect(BigInt(s.inventoryUnits)).toBe(0n); // flattened
    expect(BigInt(s.realisedPnlUnits)).toBeLessThan(0n); // the loss was REALISED, not warehoused
    const exits = sink.events.filter((e) => e.kind === 'fill' && e.side === 'SELL');
    expect(exits.length).toBe(1); // the flatten went on the tape as a business event

    await tickAll(book, 2); // inside the cooldown → quotes stay pulled, nothing fills
    expect(book.snapshot().fills).toBe(fillsBefore);
    expect(BigInt(book.snapshot().inventoryUnits)).toBe(0n);
  });

  it('loss-stop off by default: the same tape warehouses the loss instead', async () => {
    const tape = [...Array.from({ length: 6 }, (_, i) => utcBar(i, 1.0, 1.0001, 0.999)), utcBar(6, 0.9, 0.9001, 0.8999)];
    const book = new MmBook(cfg(tape));
    await tickAll(book, 7);
    expect(BigInt(book.snapshot().inventoryUnits)).toBeGreaterThan(0n); // still long
    expect(BigInt(book.snapshot().unrealisedPnlUnits)).toBeLessThan(0n); // the mark, unrealised
  });

  it('session gate: a book outside its UTC window never quotes; inside it trades', async () => {
    const rth = { openMin: 13 * 60 + 30, closeMin: 20 * 60 }; // 13:30–20:00 UTC
    const offHoursBar = (minute: number): Bar => ({
      ...utcBar(minute, 1.0, 1.001, 0.999),
      timestamp: new Date(Date.UTC(2026, 0, 1, 9, minute)), // 09:xx UTC — pre-US-open
    });
    const gated = new MmBook({ ...cfg(Array.from({ length: 6 }, (_, i) => offHoursBar(i))), sessionUtc: rth });
    await tickAll(gated, 6);
    expect(gated.snapshot().fills).toBe(0); // stood aside all tape

    const open = new MmBook({ ...cfg(Array.from({ length: 6 }, (_, i) => utcBar(i, 1.0, 1.001, 0.999))), sessionUtc: rth });
    await tickAll(open, 6);
    expect(open.snapshot().fills).toBeGreaterThan(0); // same tape inside the window trades
  });

  it('session gate: crossing out of the window flattens the inventory it holds', async () => {
    const rth = { openMin: 13 * 60 + 30, closeMin: 20 * 60 };
    const tape = [
      ...Array.from({ length: 6 }, (_, i) => utcBar(i, 1.0, 1.0001, 0.999)), // 14:xx — builds a long
      { ...utcBar(7, 1.0, 1.0001, 0.999), timestamp: new Date(Date.UTC(2026, 0, 1, 20, 1)) }, // 20:01 — closed
    ];
    const book = new MmBook({ ...cfg(tape), sessionUtc: rth });
    await tickAll(book, 6);
    expect(BigInt(book.snapshot().inventoryUnits)).toBeGreaterThan(0n);
    await book.tick(); // first post-close bar
    expect(BigInt(book.snapshot().inventoryUnits)).toBe(0n); // went home flat
  });
});
