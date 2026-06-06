// Shared server-rendered partials reused across role pages (the brief's shared
// inventory). Kept here, not in any one role view, so /ops and /desk/mm compose the
// same desk controls and Activity tape without coupling to each other.
import { DeskEvent } from '../../market-making/events/desk-event';
import { html, SafeHtml, raw } from './html';

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

/**
 * The Activity tape — the live business-event feed (fills / verdict changes / book
 * lifecycle). `events` arrive oldest-first (the log's feed order); we show them
 * newest-first, capped. Shared by mm/statarb/risk.
 */
export function activityTape(events: DeskEvent[]): SafeHtml {
  const rows = events.length
    ? raw(
        [...events]
          .reverse()
          .map((e) => tapeRow(e).value)
          .join(''),
      )
    : html`<li class="dim empty">no activity yet — launch a book to start the tape</li>`;
  return html`
    <section class="panel activity">
      <div class="panel-h">activity</div>
      <ul class="tape">${rows}</ul>
    </section>
  `;
}
