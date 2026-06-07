// The stat-arb-desk role page (/desk/statarb) — UI_REDESIGN_PROMPT.md §2: per-pair
// z / β / regime, open positions, the persisted blotter, the Activity tape, and the
// control plane (launch / stop / reconfigure a pair). Mirrors /desk/mm for the
// stat-arb desk. Reads trace to LivePortfolioTrader.snapshot() + the stat-arb
// DeskEventLog + StatArbRepository (blotter); writes go through /api/stat-arb/live/*.
//
//   renderStatArbLive(snap, events) — SSE-refreshed region (summary + pair cards + tape).
//   renderStatArbBlotter(trades)    — the persisted closed-trade blotter (page-load).
//   renderStatArbLaunchForm(strats) — the static launch/reconfigure form.
//   renderStatArbPage(state)        — the full document.
import { PortfolioSnapshot, PortfolioBookRow } from '../../execution/live-portfolio-trader';
import { DeskEvent } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { usd, money, returnPct, signClass } from './format';
import { statArbControls, appendActivityTape } from './components';

/** Minimal blotter row shape (subset of StatArbTradeRow) the view needs. */
export interface BlotterRow {
  pair: string;
  side: string;
  entryZ: number;
  exitZ: number;
  pnlUnits: string;
  closedAt: string;
}

export interface StrategyOption {
  id: string;
  label: string;
}

export interface StatArbDeskState {
  snap: PortfolioSnapshot;
  events: DeskEvent[];
  /** Cursor (DeskEventLog.lastSeq()) for the append-mode tape's first poll. */
  cursor: number;
  /** Persisted closed trades (newest-first); empty when no DB / none yet. */
  blotter: BlotterRow[];
  /** Whether the blotter could be read (false ⇒ persistence/DB off). */
  blotterAvailable: boolean;
  strategies: StrategyOption[];
}

/** net P&L for a pair = realised + unrealised (both 6-dec unit strings). */
function netUnits(b: PortfolioBookRow): string {
  return (BigInt(b.realisedPnlUnits) + BigInt(b.unrealisedPnlUnits)).toString();
}

function positionBadge(position: string | null): SafeHtml {
  const p = (position ?? 'FLAT').toUpperCase();
  const cls = p === 'LONG' ? 'badge--allow' : p === 'SHORT' ? 'badge--deny' : 'badge--paper';
  return html`<span class="badge ${cls}">${p}</span>`;
}

function pairCard(b: PortfolioBookRow): SafeHtml {
  const net = netUnits(b);
  const removeBody = JSON.stringify({ pair: b.pair });
  return html`
    <div class="book-card">
      <div class="book-card-h">
        <span class="mono book-sym">${b.pair}</span>
        <span class="dim">${b.strategyId}</span>
        ${b.running ? html`<span class="badge badge--allow">RUNNING</span>` : html`<span class="badge badge--pause">STOPPED</span>`}
        ${positionBadge(b.position)}
      </div>

      <div class="quote-grid">
        <div class="q"><span class="qk">z-score</span><span class="qv mono">${b.lastZ.toFixed(2)}</span></div>
        <div class="q"><span class="qk">β</span><span class="qv mono">${b.beta.toFixed(3)}</span></div>
        <div class="q"><span class="qk">regime</span><span class="qv mono">${b.regime}</span></div>
        <div class="q"><span class="qk">equity</span><span class="qv mono">${usd(b.equityUnits)}</span></div>
        <div class="q"><span class="qk">realised</span><span class="qv mono ${signClass(b.realisedPnlUnits)}">${money(b.realisedPnlUnits)}</span></div>
        <div class="q"><span class="qk">unrealised</span><span class="qv mono ${signClass(b.unrealisedPnlUnits)}">${money(b.unrealisedPnlUnits)}</span></div>
      </div>

      <div class="book-foot">
        <span class="dim">net <span class="${signClass(net)}">${money(net)}</span> · ${returnPct(net, b.capitalUnits)} · blocked ${b.blockedEntries} · bars ${b.barsSeen}</span>
        <desk-action
          endpoint="/api/stat-arb/live/portfolio/remove"
          body="${removeBody}"
          label="remove"
          variant="danger"
          confirm="Remove + flatten ${b.pair}? This drops the book."
          title="Flatten + drop this pair"
        ></desk-action>
      </div>
    </div>
  `;
}

/** The live region: desk summary + per-pair cards. (The Activity tape is the
 *  append-mode <activity-tape> on the static page — outside this SSE-swapped region.) */
export function renderStatArbLive(snap: PortfolioSnapshot): SafeHtml {
  const net = (BigInt(snap.realisedPnlUnits) + BigInt(snap.unrealisedPnlUnits)).toString();
  const cards = snap.books.length
    ? raw(snap.books.map((b) => pairCard(b).value).join(''))
    : html`<div class="empty dim">no pairs launched — use the launch form above</div>`;

  return html`
    <section class="stat-grid">
      <div class="stat"><span class="stat-k">desk nav</span><span class="stat-v mono">${usd(snap.equityUnits)}</span></div>
      <div class="stat">
        <span class="stat-k">net p&amp;l</span>
        <span class="stat-v mono ${signClass(net)}">${money(net)} <span class="stat-sub">${returnPct(net, snap.capitalUnits)}</span></span>
      </div>
      <div class="stat"><span class="stat-k">pairs</span><span class="stat-v mono">${snap.pairCount}</span></div>
      <div class="stat">
        <span class="stat-k">loop</span>
        <span class="stat-v">${snap.running ? html`<span class="badge badge--allow">RUNNING</span>` : html`<span class="badge badge--pause">STOPPED</span>`} <span class="badge badge--paper">PAPER</span></span>
      </div>
    </section>

    <section class="book-cards">${cards}</section>
  `;
}

/** The persisted closed-trade blotter (durable record; page-load only). */
export function renderStatArbBlotter(trades: BlotterRow[], available: boolean): SafeHtml {
  if (!available) {
    return html`<section class="panel"><div class="panel-h">blotter</div><p class="dim">closed-trade blotter persists with Postgres — set the DB to record it.</p></section>`;
  }
  const rows = trades.length
    ? raw(
        trades
          .map(
            (t) => html`<tr>
              <td class="mono">${t.pair}</td>
              <td>${t.side}</td>
              <td class="num">${t.entryZ.toFixed(2)} → ${t.exitZ.toFixed(2)}</td>
              <td class="num ${signClass(t.pnlUnits)}">${money(t.pnlUnits)}</td>
              <td class="dim">${t.closedAt.slice(0, 19).replace('T', ' ')}</td>
            </tr>`.value,
          )
          .join(''),
      )
    : html`<tr><td colspan="5" class="dim empty">no closed trades yet (paper venue)</td></tr>`;
  return html`
    <section class="panel">
      <div class="panel-h">blotter — closed trades (paper venue)</div>
      <table class="book-table">
        <thead><tr><th>pair</th><th>side</th><th class="num">z entry→exit</th><th class="num">P&amp;L</th><th>closed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

/** The static launch/reconfigure form (one pair). */
export function renderStatArbLaunchForm(strategies: StrategyOption[]): SafeHtml {
  const strategyOpts = raw(strategies.map((s) => html`<option value="${s.id}">${s.label}</option>`.value).join(''));
  return html`
    <section class="panel launch">
      <div class="panel-h">launch / reconfigure a pair</div>
      <desk-form endpoint="/api/stat-arb/live/portfolio/launch" label="Launch pair" class="form-row">
        <input class="fld" name="symbolA" placeholder="symbol A (e.g. ETH)" required />
        <input class="fld" name="symbolB" placeholder="symbol B (e.g. BTC)" required />
        <input class="fld" name="beta" type="number" placeholder="β (hedge ratio)" />
        <select class="fld" name="strategyId"><option value="">strategy: default</option>${strategyOpts}</select>
        <select class="fld" name="source">
          <option value="">venue: binance</option>
          <option value="alpaca">alpaca (equities)</option>
        </select>
        <input class="fld" name="capitalUsdc" type="number" placeholder="capital USDC" />
        <input class="fld" name="notionalUsdc" type="number" placeholder="per-leg notional USDC" />
      </desk-form>
      <p class="dim hint">
        Re-launching the same pair <b>replaces</b> it — that is how you reconfigure β / strategy / lots
        (there is no separate edit endpoint). β comes from discovery; set it here for the chosen pair.
      </p>
    </section>
  `;
}

/** The full /desk/statarb document: shell + controls + launch form + blotter + live region. */
export function renderStatArbPage(state: StatArbDeskState): string {
  const body = html`
    <h1 class="page-title">Stat-arb desk</h1>
    ${statArbControls()}
    ${renderStatArbLaunchForm(state.strategies)}
    <desk-feed src="/desk/statarb/stream" target="statarb-live">
      <div id="statarb-live">${renderStatArbLive(state.snap)}</div>
    </desk-feed>
    ${appendActivityTape({ events: state.events, cursor: state.cursor, src: '/api/stat-arb/live/events' })}
    ${renderStatArbBlotter(state.blotter, state.blotterAvailable)}
  `;
  return pageShell({ title: 'Meridian · stat-arb desk', activeHref: '/desk/statarb', body: raw(body.value) });
}
