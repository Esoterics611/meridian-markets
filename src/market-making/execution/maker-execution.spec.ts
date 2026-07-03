import { acquireFill, restingOrderFilled, shortfallBps, Touch, TouchSource } from './maker-execution';

// E2 maker-execution — offline state-machine specs. A fake clock + scripted touch
// sequences drive the rest/fill/escalate logic with no real waiting; the fill rule
// is the CONSERVATIVE one (price must trade THROUGH the resting order).

/** Fake time: sleep() advances the clock; touches are served per poll in order. */
function harness(touches: (Touch | Error)[]): { cfg: { nowMs: () => number; sleep: (ms: number) => Promise<void> }; source: TouchSource; polls: () => number } {
  let t = 0;
  let i = 0;
  const source: TouchSource = async () => {
    const next = touches[Math.min(i, touches.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    cfg: { nowMs: () => t, sleep: async (ms: number) => void (t += ms) },
    source,
    polls: () => i,
  };
}

const touch = (bid: number, ask: number): Touch => ({ bidMicros: BigInt(bid * 1e6), askMicros: BigInt(ask * 1e6) });

describe('restingOrderFilled — the conservative cross-through rule', () => {
  it('a resting BUY fills only when the ask trades down through it', () => {
    const rest = 100_000_000n; // $100
    expect(restingOrderFilled('BUY', rest, touch(99.9, 100.1))).toBe(false); // untouched
    expect(restingOrderFilled('BUY', rest, touch(99.8, 100.0))).toBe(true); // ask == rest ⇒ crossed
    expect(restingOrderFilled('BUY', rest, touch(99.5, 99.9))).toBe(true);
  });

  it('a resting SELL fills only when the bid trades up through it', () => {
    const rest = 100_000_000n;
    expect(restingOrderFilled('SELL', rest, touch(99.9, 100.1))).toBe(false);
    expect(restingOrderFilled('SELL', rest, touch(100.0, 100.2))).toBe(true);
  });
});

describe('acquireFill — rest, fill, escalate', () => {
  const fees = { makerFeeBps: -0.2, takerFeeBps: 2.5 };

  it('maker fill: BUY joins the bid and fills when the ask crosses down; rebate fee + negative shortfall', async () => {
    const { cfg, source } = harness([
      touch(100.0, 100.2), // arrival: rest BUY at 100.0, mid 100.1
      touch(99.9, 100.1), // not through yet (ask 100.1 > 100.0)
      touch(99.7, 99.95), // ask ≤ rest ⇒ filled at the resting price
    ]);
    const f = await acquireFill('BUY', source, { patienceMs: 60_000, tickMs: 2_000, ...fees, ...cfg });
    expect(f.liquidity).toBe('maker');
    expect(f.priceMicros).toBe(100_000_000n);
    expect(f.feeBps).toBe(-0.2);
    expect(f.waitedMs).toBe(4_000);
    // Filled at 100.0 vs arrival mid 100.1 ⇒ ~−10bps price improvement.
    expect(f.shortfallBps).toBeCloseTo(-9.99, 1);
  });

  it('timeout: escalates to a taker cross at the freshest touch and pays the taker fee', async () => {
    const { cfg, source } = harness([touch(100.0, 100.2)]); // touch never moves
    const f = await acquireFill('BUY', source, { patienceMs: 10_000, tickMs: 2_000, ...fees, ...cfg });
    expect(f.liquidity).toBe('taker');
    expect(f.priceMicros).toBe(100_200_000n); // crossed to the ask
    expect(f.feeBps).toBe(2.5);
    expect(f.waitedMs).toBeGreaterThanOrEqual(10_000);
    expect(f.shortfallBps).toBeCloseTo(9.99, 1); // paid the half-spread
  });

  it('patience 0 is the urgent path: immediate cross at the arrival touch', async () => {
    const { cfg, source, polls } = harness([touch(100.0, 100.2)]);
    const f = await acquireFill('SELL', source, { patienceMs: 0, tickMs: 2_000, ...fees, ...cfg });
    expect(f.liquidity).toBe('taker');
    expect(f.priceMicros).toBe(100_000_000n); // SELL crosses to the bid
    expect(f.waitedMs).toBe(0);
    expect(polls()).toBe(2); // arrival + the pre-cross refresh, no resting polls
  });

  it('SELL mirror: joins the ask, fills when the bid rises through it', async () => {
    const { cfg, source } = harness([
      touch(100.0, 100.2), // rest SELL at 100.2
      touch(100.2, 100.4), // bid ≥ rest ⇒ filled
    ]);
    const f = await acquireFill('SELL', source, { patienceMs: 60_000, tickMs: 2_000, ...fees, ...cfg });
    expect(f.liquidity).toBe('maker');
    expect(f.priceMicros).toBe(100_200_000n);
    expect(f.shortfallBps).toBeLessThan(0);
  });

  it('a failed poll skips the tick (timeout still bounds the wait); a failed pre-cross refresh reuses the last good touch', async () => {
    const { cfg, source } = harness([
      touch(100.0, 100.2), // arrival
      new Error('venue hiccup'), // poll 1 fails — skipped
      touch(100.1, 100.3), // poll 2 — no fill, becomes the last good touch
      new Error('venue hiccup again'), // final refresh fails → reuse last
    ]);
    const f = await acquireFill('BUY', source, { patienceMs: 4_000, tickMs: 2_000, ...fees, ...cfg });
    expect(f.liquidity).toBe('taker');
    expect(f.priceMicros).toBe(100_300_000n); // last good ask
  });

  it('throws only when the ARRIVAL touch is unavailable (callers fall back to the legacy path)', async () => {
    const { cfg, source } = harness([new Error('down')]);
    await expect(acquireFill('BUY', source, { patienceMs: 1_000, tickMs: 500, ...fees, ...cfg })).rejects.toThrow('down');
  });

  it('rejects a crossed/degenerate touch', async () => {
    const { cfg, source } = harness([touch(100.2, 100.0)]);
    await expect(acquireFill('BUY', source, { patienceMs: 1_000, tickMs: 500, ...fees, ...cfg })).rejects.toThrow(/bad touch/);
  });
});

describe('shortfallBps — signed implementation shortfall', () => {
  it('signs by side: paying up is +, price improvement is −', () => {
    expect(shortfallBps('BUY', 100_100_000n, 100_000_000n)).toBeCloseTo(10, 5);
    expect(shortfallBps('BUY', 99_900_000n, 100_000_000n)).toBeCloseTo(-10, 5);
    expect(shortfallBps('SELL', 99_900_000n, 100_000_000n)).toBeCloseTo(10, 5);
    expect(shortfallBps('SELL', 100_100_000n, 100_000_000n)).toBeCloseTo(-10, 5);
  });
});
