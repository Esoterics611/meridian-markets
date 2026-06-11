// EventCalendar (Journal #57) — known-time event risk, made actionable. Pro-desk doctrine:
// you don't trade through a scheduled number; you pull/widen before it and re-enter after.
// v1 is STATIC + in-code (no external feed, paper-honest): the daily US open/macro slot, the
// US close, and the published 2026 FOMC decision dates. The trader polls upcoming() each loop
// and emits a tape warning at T−warn so the operator (and the log) see it coming; the HARD
// auto-flat is the MM_EVENT_BLACKOUT guardrail window (daily windows; FOMC days are warn-only
// in v1 — add the date to the blackout env on the day, honestly noted).

export interface DeskCalendarEvent {
  /** Stable occurrence key (event id + UTC date) — the warn-once cursor. */
  key: string;
  label: string;
  tsMs: number;
  /** Books most exposed (hint for the operator; '' = whole desk). */
  booksHint: string;
}

/** 2026 FOMC decision days (published schedule; statement ~18:00Z / presser 18:30Z). */
const FOMC_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];

const DAILY: Array<{ id: string; utcMin: number; label: string; booksHint: string }> = [
  { id: 'us-open', utcMin: 13 * 60 + 30, label: 'US open + macro print slot (CPI/NFP/retail drop 13:30Z)', booksHint: 'xyz:CL, xyz:GOLD' },
  { id: 'us-close', utcMin: 20 * 60, label: 'US equity close (20:00Z) — RWA flow dries up', booksHint: 'xyz:CL, xyz:GOLD' },
];

export class EventCalendar {
  /** Occurrences in [nowMs, nowMs+horizonMs], soonest first. */
  upcoming(nowMs: number, horizonMs: number): DeskCalendarEvent[] {
    const out: DeskCalendarEvent[] = [];
    // daily events: check today + tomorrow (horizon may cross midnight)
    for (const dayOffset of [0, 1]) {
      const day = new Date(nowMs + dayOffset * 86_400_000);
      const dayUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      const dateKey = new Date(dayUtc).toISOString().slice(0, 10);
      for (const e of DAILY) {
        const ts = dayUtc + e.utcMin * 60_000;
        if (ts >= nowMs && ts <= nowMs + horizonMs) out.push({ key: `${e.id}:${dateKey}`, label: e.label, tsMs: ts, booksHint: e.booksHint });
      }
      if (FOMC_2026.includes(dateKey)) {
        const ts = dayUtc + 18 * 3_600_000;
        if (ts >= nowMs && ts <= nowMs + horizonMs)
          out.push({ key: `fomc:${dateKey}`, label: 'FOMC decision (18:00Z) + presser (18:30Z) — WHOLE-DESK risk; consider manual flat', tsMs: ts, booksHint: '' });
      }
    }
    return out.sort((a, b) => a.tsMs - b.tsMs);
  }
}
