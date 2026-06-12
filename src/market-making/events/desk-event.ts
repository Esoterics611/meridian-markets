// DeskEvent — a single human-meaningful business event from the live desk:
// a trade entering/exiting, a risk-verdict change, a book launched/removed, the
// loop starting/stopping. This is the "key business log" layer that sits ABOVE
// the Prometheus metrics (numbers scraped at /metrics) and the durable mm_nav
// table (per-interval equity rows): metrics answer "how much / how fast", the
// event stream answers "what just happened, on which book, right now".
//
// Each event is emitted exactly ONCE (from the one place the thing happens —
// MmBook.tick for fills/verdicts, MmPortfolioTrader for lifecycle) and rendered
// in TWO places by the sink: a NestJS log line (so the operator watching the
// server sees every fill scroll past) and a bounded in-memory ring buffer the
// /api/market-making/events endpoint serves to the /demo activity feed.
//
// Units (CLAUDE.md §3): bigints are carried as decimal STRINGS so an event is
// JSON-safe straight to the wire — sizeUnits/inventoryUnits are 6-dec asset
// units, priceMicros is 6-dec price, *Units money fields are 6-dec USDC-units.

export type DeskEventKind =
  | 'fill' // a passive maker fill — a trade entered or exited inventory
  | 'verdict' // the risk gate's verdict CHANGED (Allow ⇄ Pause ⇄ Deny)
  | 'launch' // a book was launched on an instrument
  | 'remove' // a book was flattened + dropped
  | 'hedge' // the desk delta-hedge traded a perp leg to flatten net delta
  | 'blocked' // an automatic control SUPPRESSED an action (F1 anti-churn, F3 conc-cap), with its numbers
  | 'control' // an automatic control CHANGED state (F3 skew ramp etc.) — the CONTROL ▸ grammar
  | 'flow' // a book's aggressor-flow sign flipped (the F1 add-freeze trigger)
  | 'start' // the desk loop started ticking
  | 'stop'; // the desk loop stopped

// How a fill moved the position — the "enter vs exit" the operator asked for.
//   open   — from flat, a new position
//   add    — extended the existing side (still entering)
//   reduce — partially closed the existing side (exiting, books realised P&L)
//   close  — closed to flat (exiting)
//   flip   — crossed through zero to the opposite side (exit + re-enter)
export type FillAction = 'open' | 'add' | 'reduce' | 'close' | 'flip';

export type FillSide = 'BUY' | 'SELL';

export interface DeskEvent {
  /** Monotonic sequence assigned by the sink — the cursor the UI polls with (`?since=`). */
  seq: number;
  /** Epoch ms. */
  ts: number;
  /** Which desk produced it. */
  desk: 'mm' | 'stat-arb';
  kind: DeskEventKind;
  /** Book/symbol; '' for a desk-level event (start/stop). */
  book: string;
  /** Venue/source id ('hyperliquid'/'binance'/…); '' when not applicable. */
  source: string;
  /** Pre-formatted human line (what the log + feed show). */
  message: string;
  // fill specifics (present on kind === 'fill')
  side?: FillSide;
  action?: FillAction;
  sizeUnits?: string;
  priceMicros?: string;
  /** Inventory AFTER the fill (signed asset units). */
  inventoryUnits?: string;
  /** Realised P&L this fill booked (0 on open/add; signed on reduce/close/flip). */
  realisedDeltaUnits?: string;
  /** Signed fee on the fill (+ cost, − maker rebate). */
  feeUnits?: string;
  /** F2: WHY a TAKER cross happened (loss-stop/session-close/event-blackout/remove/manual);
   *  absent on maker fills — the per-reason fee attribution key in the durable tape. */
  trigger?: string;
  // verdict specifics (present on kind === 'verdict')
  verdict?: string;
  prevVerdict?: string;
}

/** An event minus the sink-assigned cursor — what call-sites construct. */
export type DeskEventInput = Omit<DeskEvent, 'seq'>;

const MICROS = 1_000_000;

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** units (6-dec) → a trimmed decimal string, e.g. 500000n → "0.5", 1200000n → "1.2". */
export function fmtQty(units: bigint): string {
  // Strip trailing zeros (and a then-dangling dot) from a fixed 4-dp rendering.
  return (Number(units) / MICROS).toFixed(4).replace(/\.?0+$/, '');
}

/** price micros (6-dec) → grouped 2-dp string, e.g. 63801500000n → "63,801.50". */
export function fmtPrice(micros: bigint): string {
  return (Number(micros) / MICROS).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** USDC-units (6-dec) → signed money, e.g. 12400000n → "+$12.40", -60000n → "−$0.06". */
export function fmtMoney(units: bigint): string {
  const n = Number(units) / MICROS;
  const sign = n < 0 ? '−' : '+';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Classify how a fill moved the position from `before` to `after` (signed units). */
export function classifyFill(before: bigint, after: bigint): FillAction {
  if (before === 0n) return 'open';
  if (after === 0n) return 'close';
  const sameSide = before > 0n === after > 0n;
  if (!sameSide) return 'flip';
  return bigAbs(after) > bigAbs(before) ? 'add' : 'reduce';
}

/** The side a fill acted on, derived from the order side + whether it entered or exited. */
function actionPhrase(side: FillSide, action: FillAction): string {
  // Entering: the new/extended side is the order side. Exiting: a SELL works off a
  // long, a BUY works off a short — so the affected side is the OPPOSITE of the order.
  const enterDir = side === 'BUY' ? 'long' : 'short';
  const exitDir = side === 'BUY' ? 'short' : 'long';
  switch (action) {
    case 'open':
      return `opened ${enterDir}`;
    case 'add':
      return `added to ${enterDir}`;
    case 'reduce':
      return `reduced ${exitDir}`;
    case 'close':
      return `closed ${exitDir} flat`;
    case 'flip':
      return `flipped ${exitDir}→${enterDir}`;
  }
}

/** Build a fill event (message pre-rendered). `trigger` (F2): WHY a TAKER cross happened
 *  (loss-stop / session-close / event-blackout / remove / manual) — undefined for maker fills.
 *  It rides into the durable tape's payload, so taker fees are attributable per reason. */
export function fillEvent(p: {
  ts: number;
  book: string;
  source: string;
  side: FillSide;
  action: FillAction;
  sizeUnits: bigint;
  priceMicros: bigint;
  inventoryUnits: bigint;
  realisedDeltaUnits: bigint;
  feeUnits: bigint;
  trigger?: string;
}): DeskEventInput {
  const tail =
    p.action === 'open' || p.action === 'add'
      ? ` (fee ${fmtMoney(-p.feeUnits)})` // fee shown as its P&L sign: a rebate reads +
      : ` realised ${fmtMoney(p.realisedDeltaUnits)} (fee ${fmtMoney(-p.feeUnits)})`;
  const message =
    `${p.book} ▸ ${p.side} ${fmtQty(p.sizeUnits)} @ ${fmtPrice(p.priceMicros)} — ` +
    `${actionPhrase(p.side, p.action)} → inv ${fmtQty(p.inventoryUnits)}${tail}` +
    (p.trigger ? ` [taker: ${p.trigger}]` : '');
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'fill',
    book: p.book,
    source: p.source,
    message,
    side: p.side,
    action: p.action,
    sizeUnits: p.sizeUnits.toString(),
    priceMicros: p.priceMicros.toString(),
    inventoryUnits: p.inventoryUnits.toString(),
    realisedDeltaUnits: p.realisedDeltaUnits.toString(),
    feeUnits: p.feeUnits.toString(),
    ...(p.trigger ? { trigger: p.trigger } : {}),
  };
}

/** Build a risk-verdict-change event (emitted only on a transition, not every block). */
export function verdictEvent(p: { ts: number; book: string; source: string; prev: string; next: string }): DeskEventInput {
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'verdict',
    book: p.book,
    source: p.source,
    message: `${p.book} ▸ risk ${p.prev} → ${p.next}` + (p.next === 'Allow' ? ' (resumed quoting)' : ' (quoting blocked)'),
    verdict: p.next,
    prevVerdict: p.prev,
  };
}

/** Build a desk delta-hedge rebalance event (HEDGING_MODEL.md): a perp leg traded to flatten the
 *  desk's net delta. Emitted once per rebalance order so the hedge is auditable on the SAME tape
 *  as fills — Journal #44 DR-2 (before this, the hedge traded invisibly in memory). */
export function hedgeEvent(p: { ts: number; underlying: string; side: 'buy' | 'sell'; notionalUsd: number; residualUsd: number; reason: string }): DeskEventInput {
  const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'hedge',
    book: p.underlying,
    source: 'hl-perp-hedge',
    message: `HEDGE ▸ ${p.side.toUpperCase()} ${usd(p.notionalUsd)} ${p.underlying}-perp — ${p.reason} → residual ${usd(p.residualUsd)}`,
  };
}

/** Build an F1 anti-churn suppression event (band-hold / min-hold / flip-cooldown / flow-freeze /
 *  net-first / basis-gate). PART V observability: every automatic suppression is a logged,
 *  structured event WITH its triggering numbers — the run is auditable without a debugger.
 *  Continuous conditions arrive pre-rate-bounded by the controller. */
export function blockedEvent(p: { ts: number; book: string; rule: string; detail: string; source?: string }): DeskEventInput {
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'blocked',
    book: p.book,
    source: p.source ?? '',
    message: `BLOCKED ▸ ${p.book} ${p.rule}: ${p.detail}`,
  };
}

/** Build an automatic-control state-change event (F3 concentration ramp etc.) — the
 *  `CONTROL ▸` grammar of the PART V observability requirement. Change-driven, not periodic. */
export function controlEvent(p: { ts: number; book: string; detail: string }): DeskEventInput {
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'control',
    book: p.book,
    source: '',
    message: `CONTROL ▸ ${p.book} ${p.detail}`,
  };
}

/** Build a flow sign-flip event (F1 §5: the front of the move reversed — hedge adds freeze). */
export function flowFlipEvent(p: { ts: number; book: string; detail: string }): DeskEventInput {
  return {
    ts: p.ts,
    desk: 'mm',
    kind: 'flow',
    book: p.book,
    source: '',
    message: `FLOW ▸ flip — ${p.detail}`,
  };
}

/** Build a desk-lifecycle event (launch / remove / start / stop). */
export function lifecycleEvent(p: { ts: number; kind: Extract<DeskEventKind, 'launch' | 'remove' | 'start' | 'stop'>; book?: string; source?: string; message: string }): DeskEventInput {
  return { ts: p.ts, desk: 'mm', kind: p.kind, book: p.book ?? '', source: p.source ?? '', message: p.message };
}
