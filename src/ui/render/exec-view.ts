// The Executive role page (/exec) — read-only (UI_REDESIGN_PROMPT.md §2): desk
// NAV + drawdown + per-book P&L, the headline state. Every number here traces to
// MmPortfolioTrader.snapshot() — no mock data in a live view (CLAUDE.md §1).
//
// Two pure exports:
//   renderExecLive(snap) — the live region, refreshed over SSE (UNIT TESTED).
//   renderExecPage(snap) — the full document (shell + first server-rendered paint).
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { fmtQty } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { money, usd, pct, returnPct, signClass } from './format';
import { DRAWDOWN_BUDGET_PCT } from './components';

/** Worst single-book max-drawdown — the desk's headline drawdown proxy. */
function worstDrawdownPct(books: MmBookSnapshot[]): number {
  return books.reduce((m, b) => Math.max(m, b.maxDrawdownPct), 0);
}

function verdictBadge(verdict: string): SafeHtml {
  const kind = verdict.toLowerCase(); // allow | pause | deny
  return html`<span class="badge badge--${kind}">${verdict}</span>`;
}

function bookRow(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  return html`
    <tr>
      <td class="mono">${label}</td>
      <td class="dim">${b.family}</td>
      <td class="num ${signClass(b.netPnlUnits)}">${money(b.netPnlUnits)}</td>
      <td class="num ${signClass(b.netPnlUnits)}">${returnPct(b.netPnlUnits, b.capitalUnits)}</td>
      <td class="num ${b.maxDrawdownPct > DRAWDOWN_BUDGET_PCT ? 'neg' : 'dim'}">${pct(b.maxDrawdownPct)}</td>
      <td class="num">${fmtQty(BigInt(b.inventoryUnits))}</td>
      <td>${verdictBadge(b.lastVerdict)}</td>
      <td class="num dim">${b.fills}</td>
    </tr>
  `;
}

/**
 * The live region. Re-rendered on each SSE tick and swapped into `#exec-live`.
 * Pure: same snapshot ⇒ same HTML, so it is unit-tested directly.
 */
export function renderExecLive(snap: MmPortfolioSnapshot): SafeHtml {
  const worstDd = worstDrawdownPct(snap.books);
  const ddBreached = worstDd > DRAWDOWN_BUDGET_PCT;
  const stateBadge = snap.running
    ? html`<span class="badge badge--allow">RUNNING</span>`
    : html`<span class="badge badge--pause">PAUSED</span>`;

  const rows = snap.books.length
    ? snap.books.map(bookRow)
    : [html`<tr><td colspan="8" class="dim empty">no books launched — start a quoter from the desk</td></tr>`];

  return html`
    <section class="stat-grid">
      <div class="stat">
        <span class="stat-k">desk nav</span>
        <span class="stat-v mono">${usd(snap.equityUnits)}</span>
      </div>
      <div class="stat">
        <span class="stat-k">net p&amp;l</span>
        <span class="stat-v mono ${signClass(snap.netPnlUnits)}">
          ${money(snap.netPnlUnits)} <span class="stat-sub">${returnPct(snap.netPnlUnits, snap.capitalUnits)}</span>
        </span>
      </div>
      <div class="stat">
        <span class="stat-k">max book drawdown</span>
        <span class="stat-v mono ${ddBreached ? 'neg' : 'flat'}">
          ${pct(worstDd)} <span class="stat-sub">/ ${pct(DRAWDOWN_BUDGET_PCT)} budget</span>
        </span>
      </div>
      <div class="stat">
        <span class="stat-k">state</span>
        <span class="stat-v">${stateBadge} <span class="badge badge--paper">PAPER</span></span>
      </div>
      <div class="stat">
        <span class="stat-k">books</span>
        <span class="stat-v mono">${snap.bookCount}</span>
      </div>
    </section>

    <table class="book-table">
      <thead>
        <tr>
          <th>book</th><th>strategy</th><th class="num">net p&amp;l</th><th class="num">return</th>
          <th class="num">max dd</th><th class="num">inventory</th><th>verdict</th><th class="num">fills</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="asof dim">streaming · paper-only · every number from <code>/api/market-making/snapshot</code></p>
  `;
}

/** The full /exec document: shared shell + a server-rendered first paint of the live region. */
export function renderExecPage(snap: MmPortfolioSnapshot): string {
  const body = html`
    <h1 class="page-title">Executive — desk overview</h1>
    <desk-feed src="/exec/stream" target="exec-live">
      <div id="exec-live">${renderExecLive(snap)}</div>
    </desk-feed>
  `;
  return pageShell({ title: 'Meridian · exec', activeHref: '/exec', body: raw(body.value) });
}
