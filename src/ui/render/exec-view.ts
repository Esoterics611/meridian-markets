// The Executive role page (/exec) — read-only (UI_REDESIGN_PROMPT.md §2): the FUND
// view. The fund = the MM desk (in-process, MmPortfolioTrader.snapshot()) + the
// carry desk (a separate supervised process, read via CarryReadService's durable
// checkpoints — UI_REWRITE_PLAN_II U2). Deliberately two curves, not one merged
// number: different capital bases and cadences — two honest curves beat one
// synthetic one. No mock data in a live view (CLAUDE.md §1).
//
// Two pure exports:
//   renderExecLive(snap, carry?) — the live region, refreshed over SSE (UNIT TESTED).
//   renderExecPage(snap, carry?) — the full document (shell + first server-rendered paint).
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { CarryDeskView } from '../../market-making/carry/carry-read.service';
import { fmtQty } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { age, money, usd, pct, returnPct, signClass } from './format';
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

const CARRY_LIVENESS_CLS: Record<CarryDeskView['liveness']['state'], string> = {
  LIVE: 'badge--allow',
  STALE: 'badge--pause',
  DOWN: 'badge--deny',
  IDLE: 'badge--paper',
};

/**
 * The carry-desk strip on the fund view (U2): the exec's four questions — alive?
 * judged P&L? inside the budget? how many books? Depth lives on /desk/carry.
 */
export function renderCarryStrip(carry: CarryDeskView): SafeHtml {
  if (carry.dbOff) {
    return html`
      <section class="panel">
        <div class="panel-h">carry desk — the 30-day P0 run · <a href="/desk/carry">open →</a></div>
        <p class="dim">DB off / unreachable — the carry desk persists to Postgres; nothing truthful to show here.</p>
      </section>
    `;
  }
  const l = carry.liveness;
  const d = carry.desk;
  const ddCls = d.maxDrawdownPct === null ? 'dim' : d.maxDrawdownPct >= 0.4 ? 'neg' : d.maxDrawdownPct >= 0.25 ? 'warn' : 'flat';
  return html`
    <section class="panel">
      <div class="panel-h">carry desk — the 30-day P0 run · <a href="/desk/carry">open →</a></div>
      <section class="stat-grid">
        <div class="stat">
          <span class="stat-k">process</span>
          <span class="stat-v"><span class="badge ${CARRY_LIVENESS_CLS[l.state]}">${l.state}</span>
            ${l.ageMs !== null ? html`<span class="stat-sub mono">ckpt ${age(l.ageMs)}</span>` : ''}</span>
        </div>
        <div class="stat">
          <span class="stat-k">realised-first (judged)</span>
          <span class="stat-v mono ${signClass(d.realisedFirstUnits)}">${money(d.realisedFirstUnits)}</span>
        </div>
        <div class="stat">
          <span class="stat-k">funding accrued</span>
          <span class="stat-v mono ${signClass(d.fundingUnits)}">${money(d.fundingUnits)}</span>
        </div>
        <div class="stat">
          <span class="stat-k">max dd / 0.5% budget</span>
          <span class="stat-v mono ${ddCls}">${d.maxDrawdownPct === null ? '—' : pct(d.maxDrawdownPct, 3)}</span>
        </div>
        <div class="stat">
          <span class="stat-k">books</span>
          <span class="stat-v mono">${d.openCount} open · ${d.closedCount} closed</span>
        </div>
      </section>
    </section>
  `;
}

/**
 * The live region. Re-rendered on each SSE tick and swapped into `#exec-live`.
 * Pure: same snapshot ⇒ same HTML, so it is unit-tested directly.
 */
export function renderExecLive(snap: MmPortfolioSnapshot, carry?: CarryDeskView): SafeHtml {
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

    ${carry ? renderCarryStrip(carry) : ''}

    <p class="asof dim">streaming · paper-only · MM numbers from <code>/api/market-making/snapshot</code>; carry from <code>/api/carry/state</code> (the runner's durable checkpoints)</p>
  `;
}

/** The two full equity charts (UI_REWRITE_PLAN_III P1) — the sparklines grown up:
 *  equity, running drawdown vs budget, and the P&L components, per desk. They reuse
 *  the desk pages' own ChartSpec endpoints (one source of truth per curve), stay
 *  OUTSIDE the SSE region (self-refreshing), and degrade honestly without MM_PERSIST. */
function execChartPanel(title: string, src: string): SafeHtml {
  return html`
    <section class="panel">
      <div class="panel-h">${title}</div>
      <mkt-chart src="${src}" refresh="60"></mkt-chart>
    </section>
  `;
}

/** The full /exec document: shared shell + a server-rendered first paint of the live region. */
export function renderExecPage(snap: MmPortfolioSnapshot, carry?: CarryDeskView): string {
  const body = html`
    <h1 class="page-title">Executive — fund overview (MM desk + carry desk)</h1>
    <desk-feed src="/exec/stream" target="exec-live">
      <div id="exec-live">${renderExecLive(snap, carry)}</div>
    </desk-feed>
    ${execChartPanel('MM desk — equity · drawdown vs 2% budget · P&L components', '/desk/mm/chart')}
    ${carry && !carry.dbOff ? execChartPanel('carry desk — equity · drawdown vs 0.5% budget · components', '/desk/carry/chart') : ''}
  `;
  return pageShell({ title: 'Meridian · exec', activeHref: '/exec', body: raw(body.value) });
}
