// The flow-toxicity page (/desk/toxicity) — TRADER_UI_SPEC.md §3, study §2.2:
// "what's running over my book right now?" Per-book VPIN gauges (greyed until
// the EMA window is warmed — the honesty rule), the live F3 scale, signed book /
// trade-flow imbalance bars, and the RiskGate verdict chip. The 15-min history
// strip is the <tox-strips> Web Component (self-polls the snapshot endpoint, so
// it lives OUTSIDE the SSE region like nav-spark / activity-tape).
//
// Colour semantics (binding, format.ts): VPIN / F3 / imbalances are DIAGNOSTICS
// and direction, not money — they render neutral/dim, never pos/neg. Only the
// verdict chip carries traffic-light colour (the gate intervening = amber/red).
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';

function verdictBadge(verdict: string): SafeHtml {
  return html`<span class="badge badge--${verdict.toLowerCase()}">${verdict}</span>`;
}

/** A signed −1→+1 bar, anchored at the centre. Direction is neutral (not good/bad). */
function signedBar(label: string, v: number | undefined): SafeHtml {
  if (v === undefined) {
    return html`<div class="tox-imb"><span class="tox-k dim">${label}</span><span class="dim">n/a (bar path)</span></div>`;
  }
  const clamped = Math.max(-1, Math.min(1, v));
  const width = Math.abs(clamped) * 50;
  const side = clamped >= 0 ? 'left:50%' : `left:${(50 - width).toFixed(1)}%`;
  return html`
    <div class="tox-imb" title="${label}: ${clamped.toFixed(2)}">
      <span class="tox-k dim">${label}</span>
      <span class="imb-bar"><span class="imb-fill" style="${side};width:${width.toFixed(1)}%"></span></span>
      <span class="mono tox-v">${clamped >= 0 ? '+' : '−'}${Math.abs(clamped).toFixed(2)}</span>
    </div>
  `;
}

/** The VPIN gauge — greyed with a "warming m/n" note until bucketsSeen clears the EMA window. */
function vpinGauge(b: MmBookSnapshot): SafeHtml {
  const warmed = b.vpinBuckets >= b.vpinWindowBuckets;
  if (!warmed) {
    return html`
      <div class="tox-imb">
        <span class="tox-k dim">vpin</span>
        <span class="imb-bar imb-bar--off"></span>
        <span class="dim">warming ${b.vpinBuckets}/${b.vpinWindowBuckets} buckets</span>
      </div>
    `;
  }
  const v = Math.max(0, Math.min(1, b.vpin));
  return html`
    <div class="tox-imb" title="VPIN ${v.toFixed(2)} over ${b.vpinBuckets} buckets">
      <span class="tox-k dim">vpin</span>
      <span class="imb-bar"><span class="imb-fill imb-fill--gauge" style="left:0;width:${(v * 100).toFixed(1)}%"></span></span>
      <span class="mono tox-v">${v.toFixed(2)} <span class="dim">(${b.vpinBuckets} buckets)</span></span>
    </div>
  `;
}

function bookRow(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  const f3 = b.toxicity
    ? html`<span class="mono">×${b.toxicity.lastScale.toFixed(2)}</span>
        <span class="dim">widen ${b.toxicity.widenSteps} / tighten ${b.toxicity.tightenSteps}</span>`
    : html`<span class="dim">off</span>`;
  return html`
    <div class="book-card tox-card">
      <div class="book-card-h">
        <span class="mono book-sym">${label}</span>
        ${b.warm ? '' : html`<span class="badge badge--paper">WARMING</span>`}
        ${verdictBadge(b.lastVerdict)}
      </div>
      ${vpinGauge(b)}
      ${signedBar('book imb', b.bookImbalance)}
      ${signedBar('flow imb', b.tradeFlowImbalance)}
      <div class="tox-imb"><span class="tox-k dim">F3 scale</span>${f3}</div>
    </div>
  `;
}

/** The SSE-refreshed live region: the per-book gauge cards. */
export function renderToxicityLive(snap: MmPortfolioSnapshot): SafeHtml {
  const cards = snap.books.length
    ? raw(snap.books.map((b) => bookRow(b).value).join(''))
    : html`<div class="empty dim">no books launched — nothing is running over anything</div>`;
  return html`
    <section class="book-cards">${cards}</section>
    <p class="dim hint">
      VPIN / imbalances are <b>monitoring, not yet validated as predictive</b> (the per-tick covariate
      already measured useless — toxicity-validation roadmap 1c crowns a winner on a WP2 tape). Signed
      bars are direction, not good/bad. F3 scale &gt; 1 = the defence widening into toxic flow.
    </p>
  `;
}

/** The full /desk/toxicity document: live gauges + the self-polling history strips. */
export function renderToxicityPage(snap: MmPortfolioSnapshot): string {
  const body = html`
    <h1 class="page-title">Flow toxicity — what's running over my book?</h1>
    <desk-feed src="/desk/toxicity/stream" target="tox-live">
      <div id="tox-live">${renderToxicityLive(snap)}</div>
    </desk-feed>
    <section class="panel">
      <div class="panel-h">last 15 min — vpin (solid) vs F3 scale (dashed), per book</div>
      <tox-strips src="/api/market-making/snapshot" minutes="15"></tox-strips>
    </section>
  `;
  return pageShell({ title: 'Meridian · toxicity', activeHref: '/desk/toxicity', body: raw(body.value) });
}
