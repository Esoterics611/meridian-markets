import {
  acquireFill,
  acquirePairFill,
  pairCostBps,
  PairExecutionConfig,
  PairLeg,
  restingOrderFilled,
  shortfallBps,
  Touch,
  TouchSource,
} from './maker-execution';

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

describe('acquirePairFill — the #96 TCA fix: re-peg, delta safety, fee-aware crosses, honest aborts', () => {
  // Two scripted touch sources sharing one fake clock. Each source serves its list
  // in poll order (last item repeats), mirroring the single-leg harness.
  function pairHarness(aTouches: (Touch | Error)[], bTouches: (Touch | Error)[]): {
    clock: { nowMs: () => number; sleep: (ms: number) => Promise<void> };
    aSource: TouchSource;
    bSource: TouchSource;
  } {
    let t = 0;
    const mk = (list: (Touch | Error)[]): TouchSource => {
      let i = 0;
      return async () => {
        const next = list[Math.min(i, list.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next;
      };
    };
    return {
      clock: { nowMs: () => t, sleep: async (ms: number) => void (t += ms) },
      aSource: mk(aTouches),
      bSource: mk(bTouches),
    };
  }

  // Carry-desk shape: leg A = Binance spot (maker 1 / taker 4.5), leg B = HL perp
  // (maker −0.2 rebate / taker 2.5). Voluntary double-cross fees = 3.5bps/leg — over
  // the 2bps bar at ANY spread, so opens are maker-or-don't-trade by construction.
  const legA = (source: TouchSource, side: 'BUY' | 'SELL' = 'BUY'): PairLeg =>
    ({ side, touchSource: source, makerFeeBps: 1, takerFeeBps: 4.5 });
  const legB = (source: TouchSource, side: 'BUY' | 'SELL' = 'SELL'): PairLeg =>
    ({ side, touchSource: source, makerFeeBps: -0.2, takerFeeBps: 2.5 });
  const cfg = (clock: { nowMs: () => number; sleep: (ms: number) => Promise<void> }, over: Partial<PairExecutionConfig> = {}): PairExecutionConfig =>
    ({ patienceMs: 10_000, maxTotalMs: 60_000, tickMs: 2_000, maxPairCostBps: 2, mode: 'open', ...clock, ...over });

  it('both legs fill maker (same tick) — no taker, pair cost is the fee/shortfall average', async () => {
    // NOTE: both-maker requires the fills to land on the SAME tick — a lone fill
    // triggers the delta-safety cross of the sibling (locked in by the next spec).
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2), touch(100.0, 100.2), touch(99.8, 100.0)], // BUY rests at 100.0; ask through on tick 2
      [touch(100.0, 100.2), touch(100.0, 100.2), touch(100.2, 100.4)], // SELL rests at 100.2; bid through on tick 2
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('maker');
    expect(r.b.liquidity).toBe('maker');
    expect(r.a.priceMicros).toBe(100_000_000n);
    expect(r.b.priceMicros).toBe(100_200_000n);
    expect(r.pairCostBps).toBe(pairCostBps(r.a, r.b));
    // Both legs earned ~the half-spread: pair cost ≈ (1 − 10 + (−0.2) − 10)/2 — well inside the bar.
    expect(r.pairCostBps).toBeLessThan(2);
  });

  it('DELTA SAFETY: the moment one leg fills, the sibling crosses immediately (same tick), cost bar or not', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2), touch(99.8, 100.0)], // A fills maker on tick 1
      [touch(100.0, 100.2)], // B never fills on its own — must be crossed
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('maker');
    expect(r.b.liquidity).toBe('taker');
    expect(r.b.priceMicros).toBe(100_000_000n); // SELL crossed to the bid
    expect(r.b.waitedMs).toBe(r.a.waitedMs); // completed in the same tick — the delta window is one tick
  });

  it('RE-PEG: an unfilled leg chases the touch at maker and fills at the re-pegged price, shortfall vs arrival mid', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [
        touch(100.0, 100.2), // arrival: rest BUY at 100.0 (mid 100.1)
        touch(100.4, 100.6), // market runs away — re-peg to 100.4 (old rest NOT through: ask 100.6 > 100.0)
        touch(100.2, 100.4), // ask 100.4 ≤ re-pegged rest 100.4 ⇒ maker fill at 100.4
      ],
      [touch(100.0, 100.2), touch(100.0, 100.2), touch(100.2, 100.4)], // B fills maker same tick
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('maker');
    expect(r.a.priceMicros).toBe(100_400_000n); // the CHASED price, not the arrival join
    expect(r.a.shortfallBps).toBeCloseTo(29.97, 1); // paid +30bps of chase vs arrival mid — measured honestly
  });

  it('HONEST ABORT: neither leg fills, projected cross cost over the bar ⇒ open is SKIPPED at the deadline (no fill, no cost)', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2)], // static wide-ish touch, never trades through
      [touch(100.0, 100.2)],
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock, { maxTotalMs: 20_000 }));
    if (r.status !== 'skipped') throw new Error('expected skipped');
    // Projected: fees (4.5+2.5)/2 = 3.5 + half-spread ~10bps each ⇒ ~13.5bps/leg.
    expect(r.projectedPairCostBps).toBeGreaterThan(2);
    expect(r.waitedMs).toBeGreaterThanOrEqual(20_000);
  });

  it('FEE-AWARE VOLUNTARY CROSS: with cheap fees and a tight spread, crosses both — but only after patienceMs', async () => {
    const tight = touch(100.0, 100.002); // 0.2bps wide: half-spread ≈ 0.1bps
    const { clock, aSource, bSource } = pairHarness([tight], [tight]);
    const cheapA: PairLeg = { side: 'BUY', touchSource: aSource, makerFeeBps: 0, takerFeeBps: 0.5 };
    const cheapB: PairLeg = { side: 'SELL', touchSource: bSource, makerFeeBps: 0, takerFeeBps: 0.5 };
    const r = await acquirePairFill(cheapA, cheapB, cfg(clock, { patienceMs: 6_000, maxTotalMs: 60_000 }));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('taker');
    expect(r.b.liquidity).toBe('taker');
    expect(r.a.waitedMs).toBeGreaterThanOrEqual(6_000); // respected the minimum rest
    expect(r.a.waitedMs).toBeLessThan(60_000); // crossed as soon as eligible, not at the deadline
    expect(r.pairCostBps).toBeLessThanOrEqual(2);
  });

  it("CLOSE NEVER ABORTS: mode 'close' crosses both legs at the deadline regardless of cost", async () => {
    const { clock, aSource, bSource } = pairHarness([touch(100.0, 100.2)], [touch(100.0, 100.2)]);
    const r = await acquirePairFill(legA(aSource, 'SELL'), legB(bSource, 'BUY'), cfg(clock, { mode: 'close', maxTotalMs: 10_000 }));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('taker');
    expect(r.b.liquidity).toBe('taker');
    expect(r.a.priceMicros).toBe(100_000_000n); // SELL → bid
    expect(r.b.priceMicros).toBe(100_200_000n); // BUY → ask
  });

  // LEADER/HEDGE — the first live smoke's lesson: racing both legs lets the fast
  // (perp) leg fill first, and delta safety then crosses the EXPENSIVE spot taker
  // every time (+2.9–3.3bps/leg measured). With hedge designated, only the leader
  // rests; the hedge crosses on the leader's fill.
  it('HEDGE NEVER RESTS: a through-trading hedge touch does not fill passively — it crosses only when the leader fills', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2), touch(100.0, 100.2), touch(99.8, 100.0)], // leader (spot BUY) fills maker on tick 2
      [touch(100.0, 100.2), touch(100.2, 100.4)], // hedge (perp SELL): bid trades UP through its would-be rest — must NOT fill passively
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock, { hedge: 'b' }));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('maker'); // the leader earned the passive fill
    expect(r.b.liquidity).toBe('taker'); // the hedge crossed — never a passive fill
    expect(r.b.waitedMs).toBe(r.a.waitedMs); // on the leader's fill tick — one-tick delta window
  });

  it('HEDGE MODE, OPEN: leader never fills ⇒ skipped at the deadline (the hedge is never taken alone)', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2)], // leader static — never trades through
      [touch(100.0, 100.2)],
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock, { hedge: 'b', maxTotalMs: 20_000 }));
    expect(r.status).toBe('skipped');
  });

  it('HEDGE MODE, CLOSE: leader never fills ⇒ both cross at the deadline (never dangles)', async () => {
    const { clock, aSource, bSource } = pairHarness([touch(100.0, 100.2)], [touch(100.0, 100.2)]);
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock, { hedge: 'b', mode: 'close', maxTotalMs: 10_000 }));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('taker');
    expect(r.b.liquidity).toBe('taker');
  });

  it('throws when an ARRIVAL touch is unavailable (either leg)', async () => {
    const { clock, aSource, bSource } = pairHarness([new Error('down')], [touch(100.0, 100.2)]);
    await expect(acquirePairFill(legA(aSource), legB(bSource), cfg(clock))).rejects.toThrow('down');
  });

  it('a failed mid-rest poll skips only that leg’s tick; the deadline still bounds the wait', async () => {
    const { clock, aSource, bSource } = pairHarness(
      [touch(100.0, 100.2), new Error('hiccup'), new Error('hiccup'), touch(99.8, 100.0)], // A recovers and fills
      [touch(100.0, 100.2)], // B crossed by delta safety
    );
    const r = await acquirePairFill(legA(aSource), legB(bSource), cfg(clock));
    if (r.status !== 'filled') throw new Error('expected filled');
    expect(r.a.liquidity).toBe('maker');
    expect(r.b.liquidity).toBe('taker');
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
