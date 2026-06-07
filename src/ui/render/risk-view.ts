// The Risk role page (/risk) — UI_REDESIGN_PROMPT.md §2: live drawdown vs the 2%
// budget, toxicity, risk-verdict transitions, exposure by book, and the de-risk
// levers. Everything traces to MmPortfolioTrader.snapshot() + the MM DeskEventLog.
//
// HONEST SCOPING (recorded, UI_ARCHITECTURE.md §6/§8):
//   • VPIN is NOT surfaced live — the engine's gate currently passes vpin=0
//     (mm-book.ts), so we do NOT show a VPIN number. The real, live toxicity signal
//     is one-bar adverse selection (adverseSelectionUnits), which we DO show.
//   • Per-book pause/deny + limit-lowering have no control endpoint yet. The page
//     drives the real levers that exist: stop / flatten (per desk) + remove (per
//     book), and says so — no button that claims more than it does.
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { DeskEvent } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { money, usd, pct, signClass, notionalUnits, absUnits } from './format';
import { activityTape, DRAWDOWN_BUDGET_PCT } from './components';

export interface RiskState {
  snap: MmPortfolioSnapshot;
  /** Recent risk-verdict-change events (kind==='verdict'), oldest-first. */
  verdicts: DeskEvent[];
}

function verdictBadge(verdict: string): SafeHtml {
  return html`<span class="badge badge--${verdict.toLowerCase()}">${verdict}</span>`;
}

function worstDrawdownPct(books: MmBookSnapshot[]): number {
  return books.reduce((m, b) => Math.max(m, b.maxDrawdownPct), 0);
}

/** Sum of signed / gross notional exposure across books (6-dec unit strings). */
function exposure(books: MmBookSnapshot[]): { net: string; gross: string } {
  let net = 0n;
  let gross = 0n;
  for (const b of books) {
    const n = BigInt(notionalUnits(b.inventoryUnits, b.midMicros));
    net += n;
    gross += n < 0n ? -n : n;
  }
  return { net: net.toString(), gross: gross.toString() };
}

function riskRow(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  const exp = notionalUnits(b.inventoryUnits, b.midMicros);
  const ddBreach = b.maxDrawdownPct > DRAWDOWN_BUDGET_PCT;
  const removeBody = JSON.stringify({ symbol: b.symbol });
  return html`
    <tr>
      <td class="mono">${label}</td>
      <td>${verdictBadge(b.lastVerdict)}</td>
      <td class="num ${ddBreach ? 'neg' : 'dim'}">${pct(b.maxDrawdownPct)}</td>
      <td class="num ${signClass(exp)}">${money(exp)}</td>
      <td class="num ${signClass(b.adverseSelectionUnits)}">${money(b.adverseSelectionUnits)}</td>
      <td class="num ${b.blockedQuotes > 0 ? 'neg' : 'dim'}">${b.blockedQuotes}</td>
      <td class="num">
        <desk-action
          endpoint="/api/market-making/remove"
          body="${removeBody}"
          label="flatten + drop"
          variant="danger"
          confirm="Flatten + drop ${b.symbol}? This is the per-book risk lever (no soft pause endpoint yet)."
          title="The available per-book risk action"
        ></desk-action>
      </td>
    </tr>
  `;
}

/** The live region: drawdown/exposure headline + per-book risk table + verdict feed. */
export function renderRiskLive(snap: MmPortfolioSnapshot, verdicts: DeskEvent[]): SafeHtml {
  const worstDd = worstDrawdownPct(snap.books);
  const ddBreached = worstDd > DRAWDOWN_BUDGET_PCT;
  const breachCount = snap.books.filter((b) => b.maxDrawdownPct > DRAWDOWN_BUDGET_PCT).length;
  const blockedBooks = snap.books.filter((b) => b.lastVerdict !== 'Allow').length;
  const exp = exposure(snap.books);

  const rows = snap.books.length
    ? raw(snap.books.map((b) => riskRow(b).value).join(''))
    : html`<tr><td colspan="7" class="dim empty">no books — nothing at risk</td></tr>`;

  return html`
    <section class="stat-grid">
      <div class="stat">
        <span class="stat-k">max book drawdown</span>
        <span class="stat-v mono ${ddBreached ? 'neg' : 'flat'}">${pct(worstDd)} <span class="stat-sub">/ ${pct(DRAWDOWN_BUDGET_PCT)} budget</span></span>
      </div>
      <div class="stat">
        <span class="stat-k">books over budget</span>
        <span class="stat-v mono ${breachCount > 0 ? 'neg' : 'flat'}">${breachCount}</span>
      </div>
      <div class="stat">
        <span class="stat-k">blocked books</span>
        <span class="stat-v mono ${blockedBooks > 0 ? 'neg' : 'flat'}">${blockedBooks} <span class="stat-sub">non-Allow verdict</span></span>
      </div>
      <div class="stat">
        <span class="stat-k">net / gross exposure</span>
        <span class="stat-v mono"><span class="${signClass(exp.net)}">${money(exp.net)}</span> <span class="stat-sub">/ ${usd(absUnits(exp.gross))}</span></span>
      </div>
    </section>

    <table class="book-table">
      <thead>
        <tr>
          <th>book</th><th>verdict</th><th class="num">max dd</th><th class="num">exposure</th>
          <th class="num">adverse (toxicity)</th><th class="num">blocked</th><th class="num">action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="asof dim">
      drawdown vs the ${pct(DRAWDOWN_BUDGET_PCT)} budget · <b>adverse selection</b> is the live toxicity signal
      (VPIN is computed by the engine's estimator but not yet wired into the live tick — shown as adverse here, not a fake number).
    </p>

    ${activityTape(verdicts, 'risk-verdict transitions', 'no verdict changes yet — all books quoting (Allow)')}
  `;
}

/**
 * The de-risk action palette. Only the levers that actually exist: stop quoting +
 * flatten (per desk, MM + stat-arb = the cross-desk kill switch), confirm-gated.
 * Per-book flatten+drop is on each table row.
 */
export function renderRiskActions(): SafeHtml {
  return html`
    <section class="action-palette">
      <span class="palette-label">de-risk</span>
      <desk-action endpoint="/api/market-making/stop" label="Stop MM quoting" variant="warn" title="Halt MM quoting (positions kept)"></desk-action>
      <desk-action
        endpoint="/api/market-making/flatten"
        label="Flatten MM desk"
        variant="danger"
        confirm="Flatten ALL market-making books? Crosses the spread to force every book flat."
        title="MM kill switch"
      ></desk-action>
      <desk-action
        endpoint="/api/stat-arb/live/portfolio/flatten"
        label="Flatten stat-arb desk"
        variant="danger"
        confirm="Flatten ALL stat-arb books? Closes every open pair position."
        title="Stat-arb kill switch — the two flatten buttons together are the cross-desk kill switch"
      ></desk-action>
    </section>
    <p class="dim hint">
      Per-book <b>pause/deny</b> + <b>limit-lowering</b> need a risk-control endpoint (not built yet) — today's
      levers are stop / flatten (per desk) and flatten+drop (per book, in the table).
    </p>
  `;
}

/** The full /risk document: shell + de-risk palette + the live risk region. */
export function renderRiskPage(state: RiskState): string {
  const body = html`
    <h1 class="page-title">Risk — drawdown, exposure &amp; verdicts</h1>
    ${renderRiskActions()}
    <desk-feed src="/risk/stream" target="risk-live">
      <div id="risk-live">${renderRiskLive(state.snap, state.verdicts)}</div>
    </desk-feed>
  `;
  return pageShell({ title: 'Meridian · risk', activeHref: '/risk', body: raw(body.value) });
}
