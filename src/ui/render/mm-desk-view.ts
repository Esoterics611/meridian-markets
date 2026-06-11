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
import { HedgeSnapshot } from '../../market-making/hedge/desk-hedge-controller';
import { MarkoutPoint } from '../../market-making/microstructure/markout-tracker';
import { DeskEvent, fmtPrice, fmtQty } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { usd, money, pct, returnPct, signClass } from './format';
import { deskControls, appendActivityTape, navSparkPanel, DRAWDOWN_BUDGET_PCT } from './components';
import { MIN_SAMPLES } from './markout-desk-view';

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
  /** Cursor (DeskEventLog.lastSeq()) for the append-mode tape's first poll. */
  cursor: number;
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

/**
 * The one markout number worth having next to the P&L (TRADER_UI_SPEC §4): the 60s
 * per-side markout, bps + fill count. "—" when the 60s horizon isn't configured or no
 * fill has resolved it; dim under the noise floor — same honesty rules as /desk/markout.
 */
function mo60Cell(label: string, curve: MarkoutPoint[]): SafeHtml {
  const p = curve.find((x) => x.ms === 60_000);
  if (!p || p.bps === null) {
    return html`<div class="attr"><span class="ak">${label}</span><span class="av mono dim" title="no resolved 60s markout">—</span></div>`;
  }
  const cls = p.count < MIN_SAMPLES ? 'dim' : p.bps > 0 ? 'pos' : p.bps < 0 ? 'neg' : 'flat';
  return html`<div class="attr">
    <span class="ak">${label}</span>
    <span class="av mono ${cls}" title="${p.count} fills">${p.bps >= 0 ? '+' : '−'}${Math.abs(p.bps).toFixed(1)}bp·${p.count}f</span>
  </div>`;
}

/** ▲ buy / ▼ sell / ◆ flat with magnitude — the per-book aggressor-flow readout. */
function flowLabel(flow: number | undefined): string {
  if (typeof flow !== 'number') return '—';
  const arrow = flow > 0.05 ? '▲' : flow < -0.05 ? '▼' : '◆';
  return `${arrow} ${Math.abs(flow).toFixed(2)}`;
}

function bookCard(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  const removeBody = JSON.stringify({ symbol: b.symbol });
  // Fees as their CONTRIBUTION to net (a rebate reads +, a cost −), matching the
  // Activity tape's `fmtMoney(-feeUnits)`. The cash grid then literally sums to net:
  //   net = realised + inv MTM + fees(contrib) + funding   (mm-book.ts:523 / inventory-book.ts:130)
  const feesContribUnits = (-BigInt(b.feesUnits)).toString();
  // maxDD is always-bad: it reads red once it breaches the shared drawdown budget
  // (the same threshold /exec + /risk flag), dim while inside it. F3 stays dim — it's
  // the toxicity DEFENCE firing (a diagnostic), not money for/against us.
  const ddClass = b.maxDrawdownPct > DRAWDOWN_BUDGET_PCT ? 'neg' : 'dim';
  const f3 = b.toxicity
    ? html` · F3 widen ${b.toxicity.widenSteps}/tighten ${b.toxicity.tightenSteps} · scale ${b.toxicity.lastScale.toFixed(2)} (max ${b.toxicity.maxScale.toFixed(2)})`
    : '';
  return html`
    <div class="book-card">
      <div class="book-card-h">
        <a class="mono book-sym book-sym--link" href="/desk/markout" title="markout deep-dive">${label}</a>
        <span class="dim">${b.family}</span>
        ${b.running ? html`<span class="badge badge--allow">RUNNING</span>` : html`<span class="badge badge--pause">STOPPED</span>`}
        ${verdictBadge(b.lastVerdict)}
        ${b.regime && b.regime !== 'calm'
          ? html`<span class="badge badge--pause" title="S4 sweep-regime gate: one-sided flow + same-sign drift — quotes pulled before inventory builds; cooldown = re-entry hold">${b.regime === 'sweep' ? 'SWEEP' : 'COOLDOWN'}</span>`
          : ''}
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

      <!-- #55b: the front of the move (flow), the OOS-gated lean ACTUALLY applied, and the
           delta coverage — NAKED reads red (the run53 lesson: never implicit again). -->
      <div class="quote-grid">
        <div class="q" title="signed aggressor-flow imbalance ∈[−1,1] — a sign flip = the front of the move flipping; |flow|>0.4 = one-sided (informed) tape">
          <span class="qk">flow</span>
          <span class="qv mono ${typeof b.tradeFlowImbalance === 'number' && Math.abs(b.tradeFlowImbalance) > 0.4 ? 'neg' : 'dim'}">${flowLabel(b.tradeFlowImbalance)}</span>
        </div>
        <div class="q" title="the OOS-gated directional bias the quoter is applying (q* = bias × max lots); neutral until the live signal clears the validation gate">
          <span class="qk">lean</span>
          <span class="qv mono ${typeof b.bias === 'number' && b.bias !== 0 ? (b.bias > 0 ? 'pos' : 'neg') : 'dim'}">${typeof b.bias === 'number' ? (b.bias === 0 ? 'neutral' : (b.bias > 0 ? '+' : '') + b.bias.toFixed(2)) : '—'}</span>
        </div>
        <div class="q" title="${typeof b.hedgeBeta === 'number' && b.hedgeBeta > 0 ? `delta-hedged via ${b.hedgeUnderlying} (β-weighted; factor hedge — idio remains)` : 'UNHEDGED — naked directional inventory; the only protection is being flat (loss-stop/governor)'}">
          <span class="qk">hedge</span>
          <span class="qv mono ${typeof b.hedgeBeta === 'number' && b.hedgeBeta > 0 ? 'pos' : 'neg'}">${typeof b.hedgeBeta === 'number' ? (b.hedgeBeta > 0 ? `${b.hedgeUnderlying} β${b.hedgeBeta.toFixed(2)}` : 'NAKED') : '—'}</span>
        </div>
      </div>

      <!-- Cash P&L — these four lines SUM to net P&L (the inv-MTM line is the mark-to-
           market on the open inventory position above; it is what dominates net). -->
      <div class="attr-grid">
        <div class="attr"><span class="ak">realised</span><span class="av mono ${signClass(b.realisedPnlUnits)}">${money(b.realisedPnlUnits)}</span></div>
        <div class="attr"><span class="ak">inv MTM</span><span class="av mono ${signClass(b.unrealisedPnlUnits)}">${money(b.unrealisedPnlUnits)}</span></div>
        <div class="attr"><span class="ak">fees</span><span class="av mono ${signClass(feesContribUnits)}">${money(feesContribUnits)}</span></div>
        <div class="attr"><span class="ak">funding</span><span class="av mono ${signClass(b.fundingUnits)}">${money(b.fundingUnits)}</span></div>
        <div class="attr attr--net"><span class="ak">net P&amp;L</span><span class="av mono ${signClass(b.netPnlUnits)}">${money(b.netPnlUnits)}</span></div>
      </div>
      <!-- Edge attribution. spread + warehouse (+funding −fees) ≈ net (S1 identity);
           adverse stays a per-fill markout-window diagnostic (a slice of warehouse). -->
      <div class="attr-grid attr-grid--diag">
        <div class="attr"><span class="ak">spread</span><span class="av mono ${signClass(b.spreadCapturedUnits)}">${money(b.spreadCapturedUnits)}</span></div>
        <div class="attr"><span class="ak">adverse</span><span class="av mono ${signClass(b.adverseSelectionUnits)}">${money(b.adverseSelectionUnits)}</span></div>
        <div class="attr"><span class="ak">warehouse</span><span class="av mono ${signClass(b.inventoryMtmUnits)}">${money(b.inventoryMtmUnits)}</span></div>
        ${mo60Cell('mo60 b', b.markoutBySide.buy)}
        ${mo60Cell('mo60 a', b.markoutBySide.sell)}
      </div>

      <div class="book-foot">
        <span class="dim">fills ${b.fills} (b${b.bidFills}/a${b.askFills}) · blocked ${b.blockedQuotes} · maxDD <span class="${ddClass}">${pct(b.maxDrawdownPct)}</span>${f3}</span>
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

/** USD float (the hedge snapshot speaks dollars, not micro-units) → the serialised-units string
 *  the money/usd/signClass formatters expect, so the hedge panel shares the desk's money dialect. */
function hedgeUnits(usdFloat: number): string {
  return Math.round(usdFloat * 1_000_000).toString();
}

/**
 * The desk delta-hedge panel (DR-2): the perp overlay that neutralises the desk's net delta, now
 * folded into desk net P&L — shown so a working hedge is VISIBLE (Journal #44: an invisible hedge
 * reads as no hedge). Rendered only when the hedge is enabled (show only what's live).
 */
function hedgePanel(h: HedgeSnapshot, hedgePnlUnits: string): SafeHtml {
  const neutralised = h.grossDeltaUsd > 1 ? (1 - h.residualUsd / h.grossDeltaUsd) * 100 : 0;
  // "% neutralised" is a DELTA read and over-promises (residual_mm_risk_study.md §0): the beta
  // hedge cannot touch the (1−ρ²) basis variance. Show the basis vol next to it so a ~100%
  // neutralised desk with a live basis leak reads honestly.
  const q = h.quality;
  const basisStat =
    q && q.samples > 0 && q.deskPnlVolUsdPerHour > 0
      ? html`<div class="stat">
          <span class="stat-k">basis σ</span>
          <span class="stat-v mono"
            >${usd(hedgeUnits(q.deskBasisVolUsdPerHour))}/√h
            <span class="stat-sub">${pct((100 * q.deskBasisVolUsdPerHour ** 2) / q.deskPnlVolUsdPerHour ** 2)} unhedgeable · ${Math.round(q.bucketMs / 1000)}s buckets</span></span
          >
        </div>`
      : html``;
  const legs = h.perUnderlying.filter((p) => Math.abs(p.netDeltaUsd) > 1 || Math.abs(p.hedgeNotionalUsd) > 1);
  const legCells = legs.length
    ? raw(
        legs
          .map(
            (p) =>
              html`<span class="mono">${p.underlying} Δ${money(hedgeUnits(p.netDeltaUsd))} → resid ${money(hedgeUnits(p.residualUsd))}</span>`.value,
          )
          .join(' &nbsp; '),
      )
    : html`<span class="dim">flat — no net delta to hedge</span>`;
  // Per-book hedge quality: configured β vs realized β, R² (the hedgeable share), and the basis
  // fraction — the numbers that rank names for self-vs-proxy hedging and basis-priced caps (WP6).
  const qualBooks = (q?.perBook ?? []).filter((b) => b.samples > 0);
  const qualRow = qualBooks.length
    ? raw(
        qualBooks
          .map(
            (b) =>
              html`<span class="mono">${b.symbol}→${b.underlying} β${b.betaCfg.toFixed(2)}${b.betaLive !== null ? `→${b.betaLive.toFixed(2)}` : ''}${b.r2 !== null ? ` R²${b.r2.toFixed(2)}` : ''}${b.basisShare !== null ? ` basis ${Math.round(b.basisShare * 100)}%` : ''}</span>`.value,
          )
          .join(' &nbsp; '),
      )
    : null;
  return html`
    <section class="panel">
      <div class="panel-h">delta hedge <span class="badge badge--allow">ON</span> <span class="dim">perp overlay · folded into desk net</span></div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-k">gross Δ</span><span class="stat-v mono">${usd(hedgeUnits(h.grossDeltaUsd))}</span></div>
        <div class="stat"><span class="stat-k">residual</span><span class="stat-v mono">${usd(hedgeUnits(h.residualUsd))} <span class="stat-sub">${pct(neutralised)} neutralised</span></span></div>
        ${basisStat}
        <div class="stat"><span class="stat-k">hedge p&amp;l</span><span class="stat-v mono ${signClass(hedgePnlUnits)}">${money(hedgePnlUnits)}</span></div>
        <div class="stat"><span class="stat-k">funding</span><span class="stat-v mono ${signClass(hedgeUnits(h.fundingUsd))}">${money(hedgeUnits(h.fundingUsd))}</span></div>
        <div class="stat"><span class="stat-k">cost</span><span class="stat-v mono ${signClass(hedgeUnits(-h.hedgeCostUsd))}">${money(hedgeUnits(-h.hedgeCostUsd))}</span></div>
      </div>
      <p class="dim hint">${legCells}</p>
      ${qualRow ? html`<p class="dim hint">${qualRow}</p>` : ''}
    </section>
  `;
}

/** The live region: desk summary + per-book cards. (The Activity tape is the
 *  append-mode <activity-tape> on the static page — it self-polls and must NOT be
 *  inside this SSE-swapped region, or a tick would reset its scroll + restart it.) */
export function renderMmDeskLive(snap: MmPortfolioSnapshot): SafeHtml {
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

    ${snap.hedge?.enabled ? hedgePanel(snap.hedge, snap.hedgePnlUnits ?? '0') : ''}

    <section class="book-cards">${cards}</section>
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
      <div id="mm-live">${renderMmDeskLive(state.snap)}</div>
    </desk-feed>
    ${appendActivityTape({ events: state.events, cursor: state.cursor, src: '/api/market-making/events' })}
  `;
  return pageShell({ title: 'Meridian · MM desk', activeHref: '/desk/mm', body: raw(body.value) });
}
