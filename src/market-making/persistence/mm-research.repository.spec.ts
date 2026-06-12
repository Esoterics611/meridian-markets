import { fillMarkoutRow, BufferedSink } from './mm-research.repository';
import { ResolvedMarkout } from '../microstructure/markout-tracker';

// Offline-first: the pure row mapping + the buffered sink. The SQL round-trip shares
// the mm_nav posture (migrations own the schema; append-only at the privilege layer).

describe('fillMarkoutRow (pure mapping)', () => {
  const resolved: ResolvedMarkout = {
    tFillMs: 1_780_000_000_000,
    side: 'BUY',
    fairMidMicros: 100_000_000n, // $100
    horizonMs: 5000,
    bps: -12.5,
    meta: {
      sizeUnits: 2_000_000n, // 2 coins
      priceMicros: 99_950_000n,
      flow: 0.42,
      vpin: 0.18,
      sigma: 0.0004,
      inventoryUnitsBefore: -1_000_000n,
      queueAheadUnits: 5_000_000n,
    },
  };

  it('maps the fill context onto the insert row, notional = size × price', () => {
    const r = fillMarkoutRow('SOL', 'hyperliquid', resolved);
    expect(r).toMatchObject({
      bookKey: 'SOL',
      source: 'hyperliquid',
      side: 'BUY',
      horizonMs: 5000,
      markoutBps: -12.5,
      flow: 0.42,
      vpin: 0.18,
      sigma: 0.0004,
      inventoryUnitsBefore: -1_000_000n,
      queueAheadUnits: 5_000_000n,
    });
    expect(r.ts).toEqual(new Date(1_780_000_000_000));
    expect(r.notionalUnits).toBe((2_000_000n * 99_950_000n) / 1_000_000n); // $199.90
  });

  it('a meta-less resolution degrades to fair-mid price, zero size, null context', () => {
    const r = fillMarkoutRow('SOL', 'hyperliquid', { ...resolved, meta: undefined });
    expect(r.priceMicros).toBe(100_000_000n);
    expect(r.sizeUnits).toBe(0n);
    expect(r.notionalUnits).toBe(0n);
    expect(r.flow).toBeNull();
    expect(r.queueAheadUnits).toBeNull();
  });
});

describe('BufferedSink — bounded buffer + batch flush (DC-5: persistence never breaks a tick)', () => {
  it('enqueue is buffered; flush drains in maxBatch batches', async () => {
    const writes: number[][] = [];
    const sink = new BufferedSink<number>(async (rows) => (writes.push([...rows]), rows.length), 't', 60_000, 100, 3);
    for (let i = 0; i < 7; i++) sink.enqueue(i);
    expect(sink.size()).toBe(7);
    await sink.flush();
    expect(sink.size()).toBe(0);
    expect(writes.map((w) => w.length)).toEqual([3, 3, 1]);
    expect(writes.flat()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('overflow drops the OLDEST rows (research degrades, the buffer never grows unbounded)', () => {
    const sink = new BufferedSink<number>(async () => 0, 't', 60_000, 3, 10);
    for (let i = 0; i < 5; i++) sink.enqueue(i);
    expect(sink.size()).toBe(3);
  });

  it('a failing write logs + never throws; later rows still flush', async () => {
    let fail = true;
    const ok: number[] = [];
    const sink = new BufferedSink<number>(
      async (rows) => {
        if (fail) throw new Error('db down');
        ok.push(...rows);
        return rows.length;
      },
      't',
      60_000,
      100,
      10,
    );
    sink.enqueue(1);
    await expect(sink.flush()).resolves.toBeUndefined();
    fail = false;
    sink.enqueue(2);
    await sink.flush();
    expect(ok).toEqual([2]);
  });
});
