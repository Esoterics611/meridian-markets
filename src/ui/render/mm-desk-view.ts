// The MM-desk role page (/desk/mm) — UI_REDESIGN_PROMPT.md §2: per-book quotes /
// inventory / PnL attribution (spread / adverse / fees / funding), risk verdicts,
// the Activity tape, AND the control plane (launch/stop/remove a book, set params).
// Reads trace to MmPortfolioTrader.snapshot() + the DeskEventLog; writes go through
// the existing /api/market-making/* endpoints via <desk-action>/<desk-form>.
//
//   renderMmDeskLive(snap, events) — the SSE-refreshed region (summary + cards + tape).
//   renderLaunchForm(strategies, presets) — the static launch/reconfigure forms.
//   renderMmDeskPage(state) — the full document.
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { DeskEvent, fmtPrice, fmtQty } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { usd, money, pct, returnPct, signClass } from './format';
import { deskControls, activityTape, navSparkPanel } from './components';

export interface StrategyOption {
  id: string;
  label: string;
}
export interface PresetOption {
  id: string;
  label: string;
}

export interface MmDeskState {
  snap: MmPortfolioSnapshot;
  /** Recent desk events, oldest-first (the log's feed order); the tape reverses them. */
  events: DeskEvent[];
  strategies: StrategyOption[];
  presets: PresetOption[];
}

function verdictBadge(verdict: string): SafeHtml {
  return html`<span class="badge badge--${verdict.toLowerCase()}">${verdict}</span>`;
}

/** A price-micros field, or "—" when there is no quote yet. */
function price(micros: string | null): string {
  return micros === null ? '—' : fmtPrice(BigInt(micros));
}

function bookCard(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  const removeBody = JSON.stringify({ symbol: b.symbol });
  return html`
    <div class="book-card">
      <div class="book-card-h">
        <span class="mono book-sym">${label}</span>
        <span class="dim">${b.family}</span>
        ${b.running ? html`<span class="badge badge--allow">RUNNING</span>` : html`<span class="badge badge--pause">STOPPED</span>`}
        ${verdictBadge(b.lastVerdict)}
        ${b.warm ? '' : html`<span class="badge badge--paper">WARMING</span>`}
      </div>

      <div class="quote-grid">
        <div class="q"><span class="qk">bid</span><span class="qv mono">${price(b.bidMicros)}</span></div>
        <div class="q"><span class="qk">mid</span><span class="qv mono">${price(b.midMicros)}</span></div>
        <div class="q"><span class="qk">ask</span><span class="qv mono">${price(b.askMicros)}</span></div>
        <div class="q"><span class="qk">reservation</span><span class="qv mono">${price(b.reservationMicros)}</span></div>
        <div class="q"><span class="qk">½-spread</span><span class="qv mono">${price(b.halfSpreadMicros)}</span></div>
        <div class="q"><span class="qk">inventory</span><span class="qv mono">${fmtQty(BigInt(b.inventoryUnits))}</span></div>
      </div>

      <div class="attr-grid">
        <div class="attr"><span class="ak">spread</span><span class="av mono ${signClass(b.spreadCapturedUnits)}">${money(b.spreadCapturedUnits)}</span></div>
        <div class="attr"><span class="ak">adverse</span><span class="av mono ${signClass(b.adverseSelectionUnits)}">${money(b.adverseSelectionUnits)}</span></div>
        <div class="attr"><span class="ak">fees</span><span class="av mono ${signClass(b.feesUnits)}">${money(b.feesUnits)}</span></div>
        <div class="attr"><span class="ak">funding</span><span class="av mono ${signClass(b.fundingUnits)}">${money(b.fundingUnits)}</span></div>
        <div class="attr attr--net"><span class="ak">net P&amp;L</span><span class="av mono ${signClass(b.netPnlUnits)}">${money(b.netPnlUnits)}</span></div>
      </div>

      <div class="book-foot">
        <span class="dim">fills ${b.fills} (b${b.bidFills}/a${b.askFills}) · blocked ${b.blockedQuotes} · maxDD ${pct(b.maxDrawdownPct)}</span>
        <desk-action
          endpoint="/api/market-making/remove"
          body="${removeBody}"
          label="remove"
          variant="danger"
          confirm="Remove + flatten ${b.symbol}? This drops the book."
          title="Flatten + drop this book"
        ></desk-action>
      </div>
    </div>
  `;
}

/** The live region: desk summary + per-book cards + the Activity tape. */
export function renderMmDeskLive(snap: MmPortfolioSnapshot, events: DeskEvent[]): SafeHtml {
  const cards = snap.books.length
    ? raw(snap.books.map((b) => bookCard(b).value).join(''))
    : html`<div class="empty dim">no books launched — use the launch form above</div>`;

  return html`
    <section class="stat-grid">
      <div class="stat"><span class="stat-k">desk nav</span><span class="stat-v mono">${usd(snap.equityUnits)}</span></div>
      <div class="stat">
        <span class="stat-k">net p&amp;l</span>
        <span class="stat-v mono ${signClass(snap.netPnlUnits)}">${money(snap.netPnlUnits)} <span class="stat-sub">${returnPct(snap.netPnlUnits, snap.capitalUnits)}</span></span>
      </div>
      <div class="stat"><span class="stat-k">books</span><span class="stat-v mono">${snap.bookCount}</span></div>
      <div class="stat">
        <span class="stat-k">loop</span>
        <span class="stat-v">${snap.running ? html`<span class="badge badge--allow">RUNNING</span>` : html`<span class="badge badge--pause">STOPPED</span>`} <span class="badge badge--paper">PAPER</span></span>
      </div>
    </section>

    <section class="book-cards">${cards}</section>

    ${activityTape(events)}
  `;
}

/** The static launch/reconfigure forms (single book + whole preset). */
export function renderLaunchForm(strategies: StrategyOption[], presets: PresetOption[]): SafeHtml {
  const strategyOpts = raw(strategies.map((s) => html`<option value="${s.id}">${s.label}</option>`.value).join(''));
  const presetOpts = raw(presets.map((p) => html`<option value="${p.id}">${p.label}</option>`.value).join(''));
  return html`
    <section class="panel launch">
      <div class="panel-h">launch / reconfigure a book</div>
      <desk-form endpoint="/api/market-making/launch" label="Launch book" class="form-row">
        <input class="fld" name="symbol" placeholder="symbol (e.g. BTC)" required />
        <select class="fld" name="strategyId"><option value="">strategy: default</option>${strategyOpts}</select>
        <select class="fld" name="source">
          <option value="">venue: binance</option>
          <option value="hyperliquid">hyperliquid</option>
          <option value="geckoterminal">geckoterminal</option>
        </select>
        <input class="fld" name="capitalUsdc" type="number" placeholder="capital USDC" />
        <input class="fld" name="quoteNotionalUsd" type="number" placeholder="quote $ notional" />
      </desk-form>
      <desk-form endpoint="/api/market-making/launch-preset" label="Launch preset" class="form-row">
        <select class="fld" name="presetId" required><option value="">preset…</option>${presetOpts}</select>
        <input class="fld" name="capitalUsdcPerBook" type="number" placeholder="capital/book USDC" />
      </desk-form>
      <p class="dim hint">
        Re-launching an existing symbol <b>replaces</b> its book — that is how you reconfigure params / lots
        (there is no separate edit endpoint). Bad input (unknown strategy/preset) is reported back on the button.
      </p>
    </section>
  `;
}

/** The full /desk/mm document: shell + desk controls + launch forms + live region. */
export function renderMmDeskPage(state: MmDeskState): string {
  const body = html`
    <h1 class="page-title">Market-making desk</h1>
    ${deskControls()}
    ${navSparkPanel({ label: 'desk equity' })}
    ${renderLaunchForm(state.strategies, state.presets)}
    <desk-feed src="/desk/mm/stream" target="mm-live">
      <div id="mm-live">${renderMmDeskLive(state.snap, state.events)}</div>
    </desk-feed>
  `;
  return pageShell({ title: 'Meridian · MM desk', activeHref: '/desk/mm', body: raw(body.value) });
}
