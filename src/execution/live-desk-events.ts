// Stat-arb desk-event builders — the pair-trade flavour of the shared business
// event tape (CLAUDE.md §8 / Telemetry P2). The market-making desk emits a
// DeskEvent for every maker fill; the stat-arb live loop emitted only lifecycle
// log lines, so its per-trade enters/exits never reached the operator's "see
// every trade in the log" surface. These builders close that gap: they produce
// the SAME DeskEventInput the MM desk does (so the one DeskEventLog renders both
// a log line and the /api/.../events feed), but shaped for a pairs trade —
// LONG/SHORT spread, per-leg notional, entry/exit z, realised round-trip P&L.
//
// A stat-arb position spans two legs at two prices, so the single-asset price/
// inventory fields stay unset and the rich detail lives in the pre-rendered
// `message`; the structured fields reused are action (open/close), sizeUnits
// (per-leg notional), realisedDeltaUnits (net P&L booked on exit) and feeUnits.

import { DeskEventInput, fmtMoney, fmtQty } from '../market-making/events/desk-event';

const DESK = 'stat-arb' as const;

export type SpreadSide = 'LONG' | 'SHORT';

/** "long A / short B" for a LONG spread, reversed for a SHORT. */
function legPhrase(side: SpreadSide, symbolA: string, symbolB: string): string {
  return side === 'LONG' ? `long ${symbolA} / short ${symbolB}` : `short ${symbolA} / long ${symbolB}`;
}

/** A position OPENED — entered the book. fee shown as its P&L sign (a cost reads −$). */
export function statArbEntryEvent(p: {
  ts: number;
  pair: string;
  source: string;
  side: SpreadSide;
  notionalUnits: bigint;
  entryZ: number;
  feeUnits: bigint;
  symbolA: string;
  symbolB: string;
}): DeskEventInput {
  const message =
    `${p.pair} ▸ OPEN ${p.side} $${fmtQty(p.notionalUnits)}/leg @ z=${p.entryZ.toFixed(2)} — ` +
    `${legPhrase(p.side, p.symbolA, p.symbolB)} (fee ${fmtMoney(-p.feeUnits)})`;
  return {
    ts: p.ts,
    desk: DESK,
    kind: 'fill',
    book: p.pair,
    source: p.source,
    message,
    action: 'open',
    sizeUnits: p.notionalUnits.toString(),
    realisedDeltaUnits: '0',
    feeUnits: p.feeUnits.toString(),
  };
}

/** A position CLOSED — exited the book, booking the round-trip P&L (net of fees). */
export function statArbExitEvent(p: {
  ts: number;
  pair: string;
  source: string;
  side: SpreadSide;
  notionalUnits: bigint;
  exitZ: number;
  realisedDeltaUnits: bigint;
  feeUnits: bigint;
}): DeskEventInput {
  const message =
    `${p.pair} ▸ CLOSE ${p.side} $${fmtQty(p.notionalUnits)}/leg @ z=${p.exitZ.toFixed(2)} — ` +
    `realised ${fmtMoney(p.realisedDeltaUnits)} (round-trip fee ${fmtMoney(-p.feeUnits)})`;
  return {
    ts: p.ts,
    desk: DESK,
    kind: 'fill',
    book: p.pair,
    source: p.source,
    message,
    action: 'close',
    sizeUnits: p.notionalUnits.toString(),
    realisedDeltaUnits: p.realisedDeltaUnits.toString(),
    feeUnits: p.feeUnits.toString(),
  };
}

/** An OPEN the pre-trade risk gate blocked (drawdown). Logged louder (verdict kind). */
export function statArbBlockedEvent(p: { ts: number; pair: string; source: string; side: SpreadSide; barIndex: number }): DeskEventInput {
  return {
    ts: p.ts,
    desk: DESK,
    kind: 'verdict',
    book: p.pair,
    source: p.source,
    message: `${p.pair} ▸ OPEN ${p.side} blocked by risk gate (drawdown) @ bar ${p.barIndex}`,
    verdict: 'Deny',
    prevVerdict: 'Allow',
  };
}

/** A book/desk lifecycle event (launch / remove / start / stop). */
export function statArbLifecycleEvent(p: {
  ts: number;
  kind: 'launch' | 'remove' | 'start' | 'stop';
  book?: string;
  source?: string;
  message: string;
}): DeskEventInput {
  return { ts: p.ts, desk: DESK, kind: p.kind, book: p.book ?? '', source: p.source ?? '', message: p.message };
}
