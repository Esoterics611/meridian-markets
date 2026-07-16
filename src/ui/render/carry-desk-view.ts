// The funding-carry desk page (/desk/carry) — UI_REWRITE_PLAN_II U1: the flagship
// P0 desk's supervisory surface. The runner is a SEPARATE process, so this page is
// strictly read-only; its "controls" are copy-the-command helpers for the real
// ones (launch-carry-30d.sh / carry-close-book.ts).
//
// The headline element is the LIVENESS banner — the #92 lesson rendered: the desk
// stalled for 3h+ and nothing on any screen said so. Checkpoint age now does.
// Honest-numbers rules: realised-first is the judged number; basis MTM is shown,
// not judged; CLOSED books stay visible (the LIT close is supposed to be seen);
// dbOff / IDLE are stated, never faked into zeros.
import { CarryBookView, CarryDeskView } from '../../market-making/carry/carry-read.service';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { navSparkPanel, chartDrawer, chartsSection } from './components';
import { age, money, pct, signClass } from './format';

/** The P0 pre-registered desk drawdown budget (carry-desk-live.ts CD_DD_BUDGET_FRAC). */
const DD_BUDGET_PCT = 0.5;

const LIVENESS_COPY: Record<CarryDeskView['liveness']['state'], { cls: string; note: string }> = {
  LIVE: { cls: 'badge--allow', note: 'runner checkpointing on cadence' },
  STALE: { cls: 'badge--pause', note: 'checkpoints lagging — investigate' },
  DOWN: { cls: 'badge--deny', note: 'no recent checkpoint with books OPEN — kill-switch and re-gate are INERT. Relaunch: bash scripts/launch-carry-30d.sh' },
  IDLE: { cls: 'badge--paper', note: 'no open books — nothing to supervise' },
};

/** The #92 banner: is the desk process alive? */
export function livenessBanner(v: CarryDeskView): SafeHtml {
  const { state, ageMs } = v.liveness;
  const c = LIVENESS_COPY[state];
  const ageTxt = ageMs !== null ? html` <span class="mono">last checkpoint ${age(ageMs)}</span>` : '';
  return html`
    <div class="panel">
      <span class="badge ${c.cls}">DESK ${state}</span>${ageTxt}
      <span class="dim"> — ${c.note}</span>
    </div>
  `;
}

function dirLabel(b: CarryBookView): string {
  return b.direction === 'SHORT_PERP' ? 'long spot / short perp' : 'short spot / long perp';
}

function bookRow(b: CarryBookView, nowMs: number): SafeHtml {
  const openAge = b.openedMs !== null && b.status === 'OPEN' ? age(nowMs - b.openedMs).replace(' ago', '') : '—';
  const basis = b.basisMtmUnits !== null
    ? html`<span class="mono ${signClass(b.basisMtmUnits)}">${money(b.basisMtmUnits)}</span>`
    : html`<span class="dim">—</span>`;
  return html`
    <tr>
      <td class="mono">${b.symbol}</td>
      <td>${b.status === 'OPEN' ? html`<span class="badge badge--allow">OPEN</span>` : html`<span class="badge badge--paper">CLOSED</span>`}</td>
      <td class="dim">${dirLabel(b)}</td>
      <td class="mono">${pct(b.gateAnnualizedPct, 1)}</td>
      <td class="mono">${openAge}</td>
      <td class="mono ${signClass(b.fundingUnits)}">${money(b.fundingUnits)}</td>
      <td class="mono ${signClass((-BigInt(b.feesUnits)).toString())}">${money((-BigInt(b.feesUnits)).toString())}</td>
      <td class="mono ${signClass(b.realisedFirstUnits)}">${money(b.realisedFirstUnits)}</td>
      <td>${basis}</td>
      <td class="dim mono">${age(nowMs - b.updatedMs)}</td>
    </tr>
  `;
}

/** The SSE-refreshed live region: liveness + desk strip + books table. */
export function renderCarryLive(v: CarryDeskView): SafeHtml {
  if (v.dbOff) {
    return html`
      <div class="panel">
        <span class="badge badge--pause">DB OFF</span>
        <span class="dim">
          — the carry desk persists to Postgres (carry_book_state + mm_nav), so this page has nothing truthful
          to show. Start it: <code>sudo docker compose up -d postgres && npm run migration:run</code>
        </span>
      </div>
    `;
  }
  const d = v.desk;
  const ddCls = d.maxDrawdownPct === null ? 'dim' : d.maxDrawdownPct >= 0.8 * DD_BUDGET_PCT ? 'neg' : d.maxDrawdownPct >= 0.5 * DD_BUDGET_PCT ? 'warn' : 'pos';
  const rows = v.books.length
    ? raw(v.books.map((b) => bookRow(b, v.asOfMs).value).join(''))
    : html`<tr><td colspan="10" class="dim">no carry books yet — the runner opens them at the boot gate</td></tr>`;
  return html`
    ${livenessBanner(v)}
    <section class="stat-grid">
      <div class="stat"><span class="stat-k">realised-first (judged)</span><span class="stat-v mono ${signClass(d.realisedFirstUnits)}">${money(d.realisedFirstUnits)}</span></div>
      <div class="stat"><span class="stat-k">funding accrued</span><span class="stat-v mono ${signClass(d.fundingUnits)}">${money(d.fundingUnits)}</span></div>
      <div class="stat"><span class="stat-k">fees</span><span class="stat-v mono ${signClass((-BigInt(d.feesUnits)).toString())}">${money((-BigInt(d.feesUnits)).toString())}</span></div>
      <div class="stat"><span class="stat-k">basis MTM (open, reported not judged)</span><span class="stat-v mono ${signClass(d.basisMtmUnits)}">${money(d.basisMtmUnits)}</span></div>
      <div class="stat"><span class="stat-k">max drawdown vs ${DD_BUDGET_PCT}% budget</span><span class="stat-v mono ${ddCls}">${d.maxDrawdownPct === null ? '—' : pct(d.maxDrawdownPct, 3)}</span></div>
      <div class="stat"><span class="stat-k">books</span><span class="stat-v mono">${d.openCount} open · ${d.closedCount} closed</span></div>
    </section>
    <section class="panel">
      <div class="panel-h">carry books (from carry_book_state — the runner's durable checkpoints)</div>
      <table class="book-table">
        <thead>
          <tr>
            <th>symbol</th><th>status</th><th>structure</th><th>gate %/yr</th><th>age</th>
            <th>funding</th><th>fees</th><th>realised-first</th><th>basis MTM</th><th>checkpoint</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    <p class="dim hint">
      realised-first = funding + realised − fees (the judged number, PROFIT_PIVOT_II P0); basis MTM is the open
      position's mark, reported not judged. CLOSED rows stay visible — a closed book's realised P&amp;L is desk
      history, bug or not (see the LIT postmortem). Numbers are as of each book's last runner checkpoint.
    </p>
  `;
}

/** The charts panel (UI_REWRITE_PLAN_III P1): the @carry aggregate + one drawer per
 *  checkpointed book (CLOSED included — the curve is desk history). OUTSIDE the SSE
 *  region; rendered at page load off the same checkpoint rows as the table. */
export function renderCarryChartsPanel(v: CarryDeskView): SafeHtml {
  const drawers = v.dbOff
    ? []
    : [
        chartDrawer({ label: 'carry desk (aggregate)', src: '/desk/carry/chart', hint: 'equity · drawdown vs 0.5% budget · funding/fees/realised' }),
        ...v.books.map((b) =>
          chartDrawer({
            label: `${b.symbol}${b.status === 'CLOSED' ? ' (closed)' : ''}`,
            src: `/desk/carry/chart?book=${encodeURIComponent(b.symbol)}`,
            hint: 'book curve — funding accrual vs fees',
          }),
        ),
      ];
  return chartsSection({
    title: 'charts — the runner’s durable curves (mm_nav @carry)',
    drawers,
    note: v.dbOff
      ? 'needs Postgres — same store as the table above.'
      : 'funding accrues as a staircase (each funding interval steps it up); fees step down at entry/exit. Charts load on open and refresh every 60s.',
  });
}

const RUNBOOK = [
  { label: 'launch the 30-day run (supervised)', cmd: 'bash scripts/launch-carry-30d.sh' },
  { label: 'is the desk alive?', cmd: 'bash scripts/launch-carry-30d.sh status' },
  { label: 'graceful stop (books checkpoint OPEN)', cmd: 'bash scripts/launch-carry-30d.sh stop' },
  { label: 'close ONE book out-of-band (runner down)', cmd: 'CCB_SYMBOL=<SYM> CCB_REASON="<why>" npx ts-node -r tsconfig-paths/register scripts/carry-close-book.ts' },
];

/** The full /desk/carry document. */
export function renderCarryPage(v: CarryDeskView): string {
  const cmds = RUNBOOK.map(
    (c) => html`
      <div class="cmd-row">
        <span class="dim">${c.label}</span>
        <copy-cmd><code class="cmd-code">${c.cmd}</code></copy-cmd>
      </div>
    `,
  );
  const body = html`
    <h1 class="page-title">Carry desk — the 30-day forward run (P0)</h1>
    <desk-feed src="/desk/carry/stream" target="carry-live">
      <div id="carry-live">${renderCarryLive(v)}</div>
    </desk-feed>
    ${navSparkPanel({ book: '@carry', hours: 48, label: 'carry desk equity' })}
    ${renderCarryChartsPanel(v)}
    <section class="panel">
      <div class="panel-h">runbook — the desk runs as its own process; this page never executes</div>
      ${raw(cmds.map((c) => c.value).join(''))}
      <p class="dim hint">
        every entry/resume passes the #92 ticker-collision guard (±5% cross-venue basis) — the full lesson is
        in the repo at <code>docs/TICKER_COLLISION_POSTMORTEM.md</code>; the operator manual is
        <code>docs/CARRY_DESK_OPERATOR_MANUAL.md</code>.
      </p>
    </section>
  `;
  return pageShell({ title: 'Meridian · carry desk', activeHref: '/desk/carry', body: raw(body.value) });
}
