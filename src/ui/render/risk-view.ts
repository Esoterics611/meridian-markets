// The Risk role page (/risk) — UI_REDESIGN_PROMPT.md §2: live drawdown vs the 2%
// budget, toxicity, risk-verdict transitions, exposure by book, and the de-risk
// levers. Everything traces to MmPortfolioTrader.snapshot() + the MM DeskEventLog.
//
// HONEST SCOPING (recorded, UI_ARCHITECTURE.md §6/§8):
//   • Adverse selection (realised toxicity cost) is shown here; the LIVE toxicity
//     gauges (VPIN, warmed-state-aware, + imbalances) live on /desk/toxicity.
//   • Per-book pause/deny + limit-lowering have no control endpoint yet. The page
//     drives the real levers that exist: stop / flatten (per desk) + remove (per
//     book), and says so — no button that claims more than it does.
//   • The exposure block (TRADER_UI_SPEC §4) is the WP3 portfolio layer's reserved
//     home: when WP3 lands (inventory vector q, live Σ, net factor delta) it extends
//     this block — add panels, don't move it.
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { HedgeSnapshot } from '../../market-making/hedge/desk-hedge-controller';
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

/** Cap utilisation: |exposure| / inventory-notional cap. Amber from 80% (nearing the
 *  rail — the gate is about to intervene); dim "no cap" when the rail isn't set. */
function capUseCell(expUnits: string, capUnits: string): SafeHtml {
  const cap = BigInt(capUnits);
  if (cap <= 0n) return html`<td class="num dim" title="MM_MAX_INVENTORY_NOTIONAL_FRAC not set">no cap</td>`;
  const use = (Number(BigInt(absUnits(expUnits))) / Number(cap)) * 100;
  const cls = use >= 80 ? 'warn' : 'dim';
  const width = Math.min(100, use);
  return html`<td class="num ${cls}" title="|exposure| / cap">
    <span class="mono">${pct(use, 0)}</span>
    <span class="cap-bar"><span class="cap-bar-fill ${cls}" style="width:${width.toFixed(0)}%"></span></span>
  </td>`;
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
      <!-- exposure is a DIRECTION (long +/short −), not good/bad → neutral, never signClass.
           adverse is signed markout (− = picked off) → red when toxic. blocked = the gate
           intervening → amber caution, not a red loss. -->
      <td class="num mono">${money(exp)}</td>
      ${capUseCell(exp, b.inventoryNotionalCapUnits)}
      <td class="num ${signClass(b.adverseSelectionUnits)}">${money(b.adverseSelectionUnits)}</td>
      <td class="num ${b.blockedQuotes > 0 ? 'warn' : 'dim'}">${b.blockedQuotes}</td>
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

/** USD float → the serialised-units string the shared money formatters expect. */
function hedgeUnits(usdFloat: number): string {
  return Math.round(usdFloat * 1_000_000).toString();
}

/**
 * The exposure block (TRADER_UI_SPEC §4): what the hedge covers vs what it can't.
 * Hedge legs per underlying (net Δ → residual) + the WP1 desk σ split (factor vs
 * basis). Renders an honest "hedge OFF" line when the overlay isn't running —
 * net exposure is then unhedged and the table above is the whole story.
 */
function exposurePanel(h: HedgeSnapshot | undefined): SafeHtml {
  if (!h?.enabled) {
    return html`
      <section class="panel exposure">
        <div class="panel-h">exposure &amp; hedge</div>
        <p class="dim hint">delta hedge OFF — the desk's net exposure is unhedged (set MM_DELTA_HEDGE=true).</p>
      </section>
    `;
  }
  const legs = h.perUnderlying.filter((p) => Math.abs(p.netDeltaUsd) > 1 || Math.abs(p.hedgeNotionalUsd) > 1);
  const legCells = legs.length
    ? raw(
        legs
          .map(
            (p) =>
              html`<span class="mono">${p.underlying} Δ${money(hedgeUnits(p.netDeltaUsd))} → hedged ${usd(hedgeUnits(Math.abs(p.hedgeNotionalUsd)))} → resid ${money(hedgeUnits(p.residualUsd))}</span>`.value,
          )
          .join(' &nbsp; '),
      )
    : html`<span class="dim">flat — no net delta to hedge</span>`;
  const q = h.quality;
  const sigma =
    q && q.samples > 0 && q.deskPnlVolUsdPerHour > 0
      ? html`<p class="dim hint">
          desk P&amp;L σ <span class="mono">${usd(hedgeUnits(q.deskPnlVolUsdPerHour))}/√h</span> = factor (hedgeable)
          <span class="mono">${usd(hedgeUnits(q.deskFactorVolUsdPerHour))}</span> vs basis (unhedgeable)
          <span class="mono">${usd(hedgeUnits(q.deskBasisVolUsdPerHour))}</span> ·
          ${pct((100 * q.deskBasisVolUsdPerHour ** 2) / q.deskPnlVolUsdPerHour ** 2)} of variance the delta hedge cannot touch
          <span class="dim">(${Math.round(q.bucketMs / 1000)}s buckets, n=${q.samples})</span>
        </p>`
      : html`<p class="dim hint">hedge-quality σ split priming — no samples yet</p>`;
  return html`
    <section class="panel exposure">
      <div class="panel-h">exposure &amp; hedge <span class="dim">— what the hedge covers vs what it can't (WP3's home)</span></div>
      <p class="dim hint">${legCells}</p>
      ${sigma}
    </section>
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
    : html`<tr><td colspan="8" class="dim empty">no books — nothing at risk</td></tr>`;

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
        <span class="stat-v mono ${blockedBooks > 0 ? 'warn' : 'flat'}">${blockedBooks} <span class="stat-sub">non-Allow verdict</span></span>
      </div>
      <div class="stat">
        <span class="stat-k">net / gross exposure</span>
        <span class="stat-v mono"><span>${money(exp.net)}</span> <span class="stat-sub">/ ${usd(absUnits(exp.gross))}</span></span>
      </div>
    </section>

    ${exposurePanel(snap.hedge)}

    <table class="book-table">
      <thead>
        <tr>
          <th>book</th><th>verdict</th><th class="num">max dd</th><th class="num">exposure</th><th class="num">cap use</th>
          <th class="num">adverse (toxicity)</th><th class="num">blocked</th><th class="num">action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="asof dim">
      drawdown vs the ${pct(DRAWDOWN_BUDGET_PCT)} budget · <b>adverse selection</b> is the realised toxicity cost;
      the live gauges (VPIN, warmed-state-aware, + imbalances) are on <a class="metrics-link" href="/desk/toxicity">/desk/toxicity</a>.
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
