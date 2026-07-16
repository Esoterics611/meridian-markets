import { FillSide } from '../inventory/inventory-book';

// Maker-execution service (PROFIT_PIVOT_II E2/R8) — kill the taker entry on the slow books.
//
// The carry desk's economics live or die on entry cost: a 4-fill round trip at taker
// (2×4.5 spot + 2×2.5 perp = 14bps) is the whole breakeven story (#72: ~4.5 days of ETH
// funding just to get flat). A patient book has no urgency — so it should REST post-only
// at the touch and let the market come to it, paying the maker fee (or EARNING the HL
// −0.2bps rebate) instead of crossing.
//
// acquireFill(side, touchSource, cfg): joins the touch on its own side (post-only — a
// resting order, never a cross), polls the touch every tickMs, and:
//   FILL rule (conservative): a resting BUY at P fills only when the best ASK trades
//   down THROUGH it (ask ≤ P); a resting SELL fills when the best bid ≥ P. No
//   queue-position credit at the touch — in paper we can't see the queue, so the fill
//   only counts when price crossed the order outright. This UNDER-fills relative to a
//   real book (a real resting order also fills from flow at the touch), and the
//   escalation covers the difference — honest in the conservative direction.
//   ESCALATE on timeout: after patienceMs, cross the spread at the freshest touch and
//   pay the taker fee. patienceMs=0 is the urgent path (immediate cross at the touch).
//
// Every fill carries its TCA: liquidity (maker/taker), waited ms, and the SIGNED
// implementation shortfall vs the arrival mid (+ = cost, − = price improvement), so the
// P1 pre-registered metric (entry cost ≤ 2bps/leg) is measured per entry, not assumed.
//
// Clock and sleeper are injectable so the state machine unit-tests offline with no
// real waiting; the live runner passes real touch sources (Binance bookTicker / HL L2).

export interface Touch {
  bidMicros: bigint;
  askMicros: bigint;
}

/** Fetch the current touch (best bid/ask) — one venue, one symbol. */
export type TouchSource = () => Promise<Touch>;

export interface MakerExecutionConfig {
  /** How long to rest post-only before escalating to taker. 0 ⇒ immediate taker. */
  patienceMs: number;
  /** Touch poll cadence while resting (keep polite — these are real API calls live). */
  tickMs: number;
  /** Fee when passively filled, signed bps (HL maker −0.2 = rebate earned). */
  makerFeeBps: number;
  /** Fee when escalated to a cross, bps. */
  takerFeeBps: number;
  /** Injectable clock/sleeper (tests); default real time. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecutedFill {
  side: FillSide;
  priceMicros: bigint;
  /** The fee actually charged for this liquidity type (signed bps). */
  feeBps: number;
  liquidity: 'maker' | 'taker';
  waitedMs: number;
  arrivalMidMicros: bigint;
  /** Signed implementation shortfall vs the arrival mid, bps (+ = cost, − = improvement). */
  shortfallBps: number;
}

/** Conservative resting-fill rule: price must trade THROUGH the order, not just touch it. */
export function restingOrderFilled(side: FillSide, restMicros: bigint, touch: Touch): boolean {
  return side === 'BUY' ? touch.askMicros <= restMicros : touch.bidMicros >= restMicros;
}

/** Signed shortfall of an executed price vs the arrival mid, bps (+ = cost). */
export function shortfallBps(side: FillSide, priceMicros: bigint, arrivalMidMicros: bigint): number {
  if (arrivalMidMicros <= 0n) return 0;
  const signed = side === 'BUY' ? priceMicros - arrivalMidMicros : arrivalMidMicros - priceMicros;
  return (Number(signed) / Number(arrivalMidMicros)) * 10_000;
}

function assertTouch(t: Touch): void {
  if (t.bidMicros <= 0n || t.askMicros <= 0n || t.askMicros < t.bidMicros) {
    throw new Error(`maker-execution: bad touch bid=${t.bidMicros} ask=${t.askMicros}`);
  }
}

/**
 * Acquire one fill: rest post-only at the touch, escalate to taker on timeout.
 * Throws only if the ARRIVAL touch cannot be fetched (callers fall back to their
 * legacy path); a failed poll mid-rest just skips that tick.
 */
export async function acquireFill(side: FillSide, touchSource: TouchSource, cfg: MakerExecutionConfig): Promise<ExecutedFill> {
  if (cfg.tickMs <= 0) throw new Error('maker-execution: tickMs must be > 0');
  const nowMs = cfg.nowMs ?? Date.now;
  const sleep = cfg.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  const t0 = nowMs();
  const arrival = await touchSource();
  assertTouch(arrival);
  const arrivalMid = (arrival.bidMicros + arrival.askMicros) / 2n;
  const rest = side === 'BUY' ? arrival.bidMicros : arrival.askMicros; // join the touch, post-only
  let last = arrival;

  const fill = (priceMicros: bigint, liquidity: 'maker' | 'taker'): ExecutedFill => ({
    side,
    priceMicros,
    feeBps: liquidity === 'maker' ? cfg.makerFeeBps : cfg.takerFeeBps,
    liquidity,
    waitedMs: nowMs() - t0,
    arrivalMidMicros: arrivalMid,
    shortfallBps: shortfallBps(side, priceMicros, arrivalMid),
  });

  while (nowMs() - t0 < cfg.patienceMs) {
    await sleep(Math.min(cfg.tickMs, cfg.patienceMs - (nowMs() - t0)));
    try {
      const t = await touchSource();
      assertTouch(t);
      last = t;
    } catch {
      continue; // one failed poll skips a tick; the timeout still bounds the wait
    }
    if (restingOrderFilled(side, rest, last)) return fill(rest, 'maker');
  }

  // Escalate: refresh the touch if possible, then cross the spread at it.
  try {
    const t = await touchSource();
    assertTouch(t);
    last = t;
  } catch {
    // keep the last good touch — at most one tick stale, bounded by tickMs
  }
  return fill(side === 'BUY' ? last.askMicros : last.bidMicros, 'taker');
}

// ── Pair execution (the #96 TCA fix) ─────────────────────────────────────────────
//
// #96 measured the single-leg path's failure mode: 45s at a STATIC join (the order
// never re-pegs as the touch moves, so on an illiquid book it goes stale and never
// trades through), then an UNCONDITIONAL full-spread cross — 4–5 of 8 carry legs
// landed at 3.5–7bps against the pre-registered ≤2bps/leg bar. And because the two
// legs ran as independent acquireFill calls, there was no pair-level cost decision
// and no delta coordination.
//
// acquirePairFill runs BOTH legs of a delta-neutral pair in one loop:
//   • RE-PEG: every tick, an unfilled leg re-joins the current touch (post-only —
//     it chases at maker, never crosses). The conservative trade-through fill rule
//     is checked against the PRE-re-peg rest each tick, so a fill is only credited
//     when price crossed the order we were actually showing.
//   • DELTA SAFETY: the moment one leg fills, the sibling crosses at its freshest
//     touch immediately — naked delta on a carry pair dwarfs any fee, so completing
//     the pair outranks the cost bar.
//   • LEADER/HEDGE (the first live smoke's lesson): racing BOTH legs at maker is a
//     trap when fill speed is asymmetric — the fast leg (HL perp) fills in seconds
//     and delta safety then crosses the EXPENSIVE leg (spot taker 4.5bps + spread)
//     every time (measured +2.9–3.3bps/leg — over the bar on every entry). Setting
//     cfg.hedge designates the cheap-taker leg as the HEDGE: it never rests; the
//     expensive-taker leg alone leads at maker, and the hedge crosses the instant
//     the leader fills. Same one-tick delta window, ~1bp expected pair cost.
//   • FEE-AWARE VOLUNTARY CROSS: with NEITHER leg filled, a double-taker cross is
//     taken only if the projected pair cost (per-leg average of taker fee +
//     shortfall vs arrival mid — the two legs' drift cancels in the average) is
//     within maxPairCostBps. At the desk's default fees (spot 4.5 + perp 2.5)/2 =
//     3.5bps of fees alone, this NEVER passes a 2bps bar — by construction: a
//     voluntary double-cross was a pre-registered failure in #96, so the executor
//     refuses to volunteer for one. Opens become maker-or-don't-trade.
//   • DEADLINE: at maxTotalMs, mode 'open' ABORTS (status 'skipped' — no fill, no
//     cost; the candidate stays gated and retries later), mode 'close' crosses
//     both unconditionally (a risk-driven close must complete).

export interface PairLeg {
  side: FillSide;
  touchSource: TouchSource;
  /** Fee when passively filled, signed bps (HL maker −0.2 = rebate earned). */
  makerFeeBps: number;
  /** Fee when crossed, bps. */
  takerFeeBps: number;
}

export interface PairExecutionConfig {
  /** Minimum rest before a voluntary (both-legs) cross may even be considered. */
  patienceMs: number;
  /** Hard deadline: 'open' aborts here (skip the entry); 'close' crosses both. */
  maxTotalMs: number;
  /** Touch poll + re-peg cadence (keep polite — real API calls live). */
  tickMs: number;
  /** The pre-registered bar: pair-average per-leg cost (fee + shortfall), bps. */
  maxPairCostBps: number;
  /** 'open' may abort on cost; 'close' always completes. */
  mode: 'open' | 'close';
  /**
   * Designate a leg as the HEDGE: it never rests — the other leg leads at maker
   * and the hedge crosses the moment the leader fills. Pick the leg whose taker
   * escalation is CHEAP (tight book, low taker fee). Omit to race both at maker.
   */
  hedge?: 'a' | 'b';
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PairFillResult =
  | { status: 'filled'; a: ExecutedFill; b: ExecutedFill; pairCostBps: number }
  | { status: 'skipped'; projectedPairCostBps: number; waitedMs: number };

interface LegState {
  spec: PairLeg;
  restMicros: bigint;
  last: Touch;
  arrivalMidMicros: bigint;
  fill: ExecutedFill | null;
}

/** Pair-average per-leg cost of two executed fills: (feeA+sfA+feeB+sfB)/2. */
export function pairCostBps(a: ExecutedFill, b: ExecutedFill): number {
  return (a.feeBps + a.shortfallBps + b.feeBps + b.shortfallBps) / 2;
}

/**
 * Acquire both legs of a delta-neutral pair: rest post-only with re-peg, complete
 * the pair the moment one leg fills, refuse voluntary crosses beyond the cost bar,
 * abort opens that cannot be done honestly. Throws only if an ARRIVAL touch cannot
 * be fetched (callers decide their fallback).
 */
export async function acquirePairFill(legA: PairLeg, legB: PairLeg, cfg: PairExecutionConfig): Promise<PairFillResult> {
  if (cfg.tickMs <= 0) throw new Error('maker-execution: tickMs must be > 0');
  const nowMs = cfg.nowMs ?? Date.now;
  const sleep = cfg.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const t0 = nowMs();

  const initLeg = async (spec: PairLeg): Promise<LegState> => {
    const arrival = await spec.touchSource();
    assertTouch(arrival);
    return {
      spec,
      restMicros: spec.side === 'BUY' ? arrival.bidMicros : arrival.askMicros, // join the touch, post-only
      last: arrival,
      arrivalMidMicros: (arrival.bidMicros + arrival.askMicros) / 2n,
      fill: null,
    };
  };
  const [a, b] = await Promise.all([initLeg(legA), initLeg(legB)]);
  const legs = [a, b];

  const executed = (leg: LegState, priceMicros: bigint, liquidity: 'maker' | 'taker'): ExecutedFill => ({
    side: leg.spec.side,
    priceMicros,
    feeBps: liquidity === 'maker' ? leg.spec.makerFeeBps : leg.spec.takerFeeBps,
    liquidity,
    waitedMs: nowMs() - t0,
    arrivalMidMicros: leg.arrivalMidMicros,
    shortfallBps: shortfallBps(leg.spec.side, priceMicros, leg.arrivalMidMicros),
  });

  const crossPrice = (leg: LegState): bigint => (leg.spec.side === 'BUY' ? leg.last.askMicros : leg.last.bidMicros);

  /** Refresh the touch if possible (at most one tick stale on failure), then cross. */
  const crossNow = async (leg: LegState): Promise<ExecutedFill> => {
    try {
      const t = await leg.spec.touchSource();
      assertTouch(t);
      leg.last = t;
    } catch {
      // keep the last good touch
    }
    return executed(leg, crossPrice(leg), 'taker');
  };

  /**
   * Projected pair cost if both unfilled legs crossed at their latest touches.
   * (A hedge leg's touch is its arrival snapshot — it is never polled while
   * resting; crossNow refreshes before any actual execution.)
   */
  const projectedCost = (): number =>
    legs.reduce((s, leg) => s + (leg.fill
      ? leg.fill.feeBps + leg.fill.shortfallBps
      : leg.spec.takerFeeBps + shortfallBps(leg.spec.side, crossPrice(leg), leg.arrivalMidMicros)), 0) / 2;

  const result = (): PairFillResult => ({ status: 'filled', a: a.fill!, b: b.fill!, pairCostBps: pairCostBps(a.fill!, b.fill!) });

  const hedgeLeg = cfg.hedge === 'a' ? a : cfg.hedge === 'b' ? b : null;

  while (nowMs() - t0 < cfg.maxTotalMs) {
    await sleep(Math.min(cfg.tickMs, cfg.maxTotalMs - (nowMs() - t0)));
    // Poll the unfilled RESTING legs (the hedge leg never rests); a failed poll
    // skips that leg's tick.
    await Promise.all(legs.filter((l) => !l.fill && l !== hedgeLeg).map(async (leg) => {
      try {
        const t = await leg.spec.touchSource();
        assertTouch(t);
        leg.last = t;
        // Fill check against the rest we were SHOWING this tick, then re-peg for the next.
        if (restingOrderFilled(leg.spec.side, leg.restMicros, t)) {
          leg.fill = executed(leg, leg.restMicros, 'maker');
        } else {
          leg.restMicros = leg.spec.side === 'BUY' ? t.bidMicros : t.askMicros;
        }
      } catch {
        /* skip this leg's tick */
      }
    }));

    if (a.fill && b.fill) return result();
    if (a.fill || b.fill) {
      // Delta safety: one leg is on — complete the pair immediately, cost bar or not.
      const open = a.fill ? b : a;
      open.fill = await crossNow(open);
      return result();
    }
    if (nowMs() - t0 >= cfg.patienceMs && projectedCost() <= cfg.maxPairCostBps) {
      a.fill = await crossNow(a);
      b.fill = await crossNow(b);
      return result();
    }
  }

  // Deadline. A lone fill always completed in-loop, so both legs are unfilled here.
  if (cfg.mode === 'close') {
    a.fill = await crossNow(a);
    b.fill = await crossNow(b);
    return result();
  }
  return { status: 'skipped', projectedPairCostBps: projectedCost(), waitedMs: nowMs() - t0 };
}
