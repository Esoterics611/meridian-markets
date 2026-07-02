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
