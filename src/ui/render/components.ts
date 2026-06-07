// Shared server-rendered partials reused across role pages (the brief's shared
// inventory). Kept here, not in any one role view, so /ops and /desk/mm compose the
// same desk controls and Activity tape without coupling to each other.
import { DeskEvent } from '../../market-making/events/desk-event';
import { html, SafeHtml, raw } from './html';

// The desk's drawdown budget (the risk doctrine's 2% cap) — shared by /exec + /risk.
// The UI flags a breach; it never enforces (enforcement is the engine's risk gate).
export const DRAWDOWN_BUDGET_PCT = 2.0;

/**
 * The MM desk control palette — Start / Stop / Flatten (the kill switch). Each
 * `<desk-action>` POSTs an existing, validated control-plane endpoint; the flatten
 * is confirm-gated. Lives OUTSIDE any SSE region so a tick can't re-create it
 * mid-click. Shared by /ops and /desk/mm.
 */
export function deskControls(): SafeHtml {
  return html`
    <section class="action-palette">
      <span class="palette-label">MM desk controls</span>
      <desk-action endpoint="/api/market-making/start" label="Start desk" variant="ok" title="Resume the quoting loop"></desk-action>
      <desk-action endpoint="/api/market-making/stop" label="Stop desk" variant="warn" title="Halt quoting (positions are kept)"></desk-action>
      <desk-action
        endpoint="/api/market-making/flatten"
        label="Flatten desk"
        variant="danger"
        confirm="Flatten ALL market-making books? This crosses the spread (taker fee) to force every book to zero inventory."
        title="Kill switch: force every book flat"
      ></desk-action>
    </section>
  `;
}

/**
 * The stat-arb desk control palette — Start / Stop / Flatten the portfolio loop.
 * Same shape + safety as deskControls() (MM), pointed at the stat-arb control
 * plane. Lives outside any SSE region. Shared by /desk/statarb (and a future
 * cross-desk kill switch on /ops).
 */
export function statArbControls(): SafeHtml {
  return html`
    <section class="action-palette">
      <span class="palette-label">stat-arb desk controls</span>
      <desk-action endpoint="/api/stat-arb/live/portfolio/start" label="Start desk" variant="ok" title="Resume the portfolio loop"></desk-action>
      <desk-action endpoint="/api/stat-arb/live/portfolio/stop" label="Stop desk" variant="warn" title="Halt the loop (positions are kept)"></desk-action>
      <desk-action
        endpoint="/api/stat-arb/live/portfolio/flatten"
        label="Flatten desk"
        variant="danger"
        confirm="Flatten ALL stat-arb books? This closes every open pair position."
        title="Kill switch: close every pair"
      ></desk-action>
    </section>
  `;
}

/**
 * The durable equity-curve sparkline panel (Telemetry P3). Wraps the shared
 * <nav-spark> Web Component, which self-fetches `/api/market-making/nav` and draws
 * the equity history as an inline SVG. MUST be placed OUTSIDE any SSE region — it
 * self-refreshes on its own timer, so an SSE tick recreating it would restart its
 * fetch. Shared by /exec (desk aggregate) + /desk/mm. Degrades honestly when
 * MM_PERSIST is off (the endpoint says so; the component shows it).
 */
export function navSparkPanel(opts: { book?: string; hours?: number; label?: string } = {}): SafeHtml {
  const book = opts.book ?? '';
  const hours = opts.hours ?? 24;
  const label = opts.label ?? (book ? `${book} equity` : 'desk equity');
  return html`
    <section class="panel nav-spark-panel">
      <div class="panel-h">equity curve · durable NAV (${hours}h)</div>
      <nav-spark book="${book}" hours="${hours}" label="${label}"></nav-spark>
    </section>
  `;
}

// Colour class per event kind for the tape badge.
function kindClass(kind: string): string {
  switch (kind) {
    case 'fill':
      return 'tape--fill';
    case 'verdict':
      return 'tape--verdict';
    case 'launch':
    case 'start':
      return 'tape--up';
    case 'remove':
    case 'stop':
      return 'tape--down';
    default:
      return '';
  }
}

function tapeRow(ev: DeskEvent): SafeHtml {
  const t = new Date(ev.ts).toISOString().slice(11, 19);
  // ev.message is pre-rendered by the engine (the same line the server log shows) —
  // we present it verbatim; the UI never re-derives business text.
  return html`<li class="tape-row ${kindClass(ev.kind)}">
    <span class="tape-t">${t}</span><span class="tape-kind">${ev.kind}</span><span class="tape-msg">${ev.message}</span>
  </li>`;
}

/** Server-render the tape rows (newest-first) or the empty note. Shared by both the
 *  full-replace tape (in-SSE) and the append-mode tape's first paint. */
function tapeRows(events: DeskEvent[], emptyNote: string): SafeHtml {
  return events.length
    ? raw(
        [...events]
          .reverse()
          .map((e) => tapeRow(e).value)
          .join(''),
      )
    : html`<li class="dim empty">${emptyNote}</li>`;
}

/**
 * The Activity tape — the live business-event feed (fills / verdict changes / book
 * lifecycle). `events` arrive oldest-first (the log's feed order); we show them
 * newest-first, capped. This is the FULL-REPLACE variant rendered INSIDE an SSE
 * region (the whole list is re-rendered each tick). Used by /risk's short verdict
 * feed; the busy desk tapes use appendActivityTape() instead. `title` + `emptyNote`
 * let the risk page reuse it as a verdict-transition feed.
 */
export function activityTape(events: DeskEvent[], title = 'activity', emptyNote = 'no activity yet — launch a book to start the tape'): SafeHtml {
  return html`
    <section class="panel activity">
      <div class="panel-h">${title}</div>
      <ul class="tape">${tapeRows(events, emptyNote)}</ul>
    </section>
  `;
}

export interface AppendTapeOpts {
  /** Recent events for the first paint, oldest-first (the log's feed order). */
  events: DeskEvent[];
  /** The events endpoint base, e.g. '/api/market-making/events'. */
  src: string;
  /** Initial cursor = DeskEventLog.lastSeq(); the first poll fetches events after it. */
  cursor: number;
  title?: string;
  emptyNote?: string;
  /** Optional client-side kind filter, e.g. 'verdict' for a risk feed. */
  kind?: string;
  /** Optional book filter passed through to the endpoint (&book=). */
  book?: string;
}

/**
 * The APPEND-MODE Activity tape — the dedicated <activity-tape> Web Component (the
 * cursor-based feed, UI_ARCHITECTURE.md §5). The server renders the initial rows
 * (newest-first) + the cursor for a correct first paint; the component then polls
 * `src?since=<cursor>` and PREPENDS only the new events, so the list isn't rebuilt
 * each tick and the operator's scroll into history is preserved. MUST be placed
 * OUTSIDE any SSE region (it self-polls; an SSE swap would recreate it and restart
 * the feed). Shared by /desk/mm + /desk/statarb.
 */
export function appendActivityTape(opts: AppendTapeOpts): SafeHtml {
  const title = opts.title ?? 'activity';
  const emptyNote = opts.emptyNote ?? 'no activity yet — launch a book to start the tape';
  const shown = opts.kind ? opts.events.filter((e) => e.kind === opts.kind) : opts.events;
  return html`
    <section class="panel activity">
      <div class="panel-h">${title}</div>
      <activity-tape src="${opts.src}" cursor="${opts.cursor}" kind="${opts.kind ?? ''}" book="${opts.book ?? ''}">
        <ul class="tape">${tapeRows(shown, emptyNote)}</ul>
      </activity-tape>
    </section>
  `;
}
