// The markout / TCA page (/desk/markout) — TRADER_UI_SPEC.md §2, study §2.1:
// "am I getting picked off?" Per-book multi-horizon markout curves split by fill
// side, with the F3 toxicity reaction on the same card so cause (toxic flow),
// effect (defence fired) and outcome (markout curve) read on one screen.
//
// Everything renders from MmPortfolioTrader.snapshot() — books[].markout /
// markoutBySide / toxicity / fill counts. No engine work, pure view.
//
// Honest-numbers rules (spec §6): every number names its horizon AND its sample
// count; a curve with < MIN_SAMPLES fills renders dimmed with a "noise — wait"
// note instead of pretending significance. Colour: green = the move went our way
// (markout ≥ 0), red = picked off — per-fill money semantics, so signClass-style
// colouring is correct here.
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { MarkoutPoint } from '../../market-making/microstructure/markout-tracker';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';

/** Below this many fills a markout average is noise (spec §2's honest note). */
export const MIN_SAMPLES = 30;
/** Amber asymmetry flag: |buy − sell| at the longest shared horizon above this, both sides sampled. */
export const ASYMMETRY_BPS = 2;
/** Bar scale: a |markout| of this many bps draws a full-width bar (clamped beyond). */
const BAR_FULL_BPS = 8;

function fmtHorizon(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m`;
}

function bpsClass(bps: number): string {
  return bps > 0 ? 'pos' : bps < 0 ? 'neg' : 'flat';
}

/** One horizon cell: signed bps + sample count + a width-∝-|bps| bar. Dim when
 *  under-sampled; "—" while no fill has resolved this horizon yet (bps null). */
function horizonCell(p: MarkoutPoint): SafeHtml {
  if (p.bps === null) {
    return html`
      <div class="mo-cell" title="no resolved fills yet">
        <span class="mo-h dim">${fmtHorizon(p.ms)}</span>
        <span class="mo-v mono dim">—</span>
        <span class="mo-bar"></span>
      </div>
    `;
  }
  const thin = p.count < MIN_SAMPLES;
  const cls = thin ? 'dim' : bpsClass(p.bps);
  const width = Math.min(100, (Math.abs(p.bps) / BAR_FULL_BPS) * 100);
  return html`
    <div class="mo-cell" title="${p.count} fills">
      <span class="mo-h dim">${fmtHorizon(p.ms)}</span>
      <span class="mo-v mono ${cls}">${p.bps >= 0 ? '+' : '−'}${Math.abs(p.bps).toFixed(2)}</span>
      <span class="mo-bar"><span class="mo-bar-fill ${cls}" style="width:${width.toFixed(0)}%"></span></span>
    </div>
  `;
}

/** One curve row (all / buy / sell): label + count + the horizon cells. */
function curveRow(label: string, curve: MarkoutPoint[], count: number): SafeHtml {
  const cells = curve.length
    ? raw(curve.map((p) => horizonCell(p).value).join(''))
    : html`<span class="dim">no fills yet</span>`;
  return html`
    <div class="mo-row">
      <span class="mo-side dim">${label} <span class="mono">${count}</span></span>
      <div class="mo-cells">${cells}</div>
    </div>
  `;
}

/** The buy-vs-sell asymmetry read at the longest horizon both sides sampled (spec §2). */
function asymmetryFlag(b: MmBookSnapshot): SafeHtml | '' {
  const horizons = b.markout.map((p) => p.ms);
  for (let i = horizons.length - 1; i >= 0; i--) {
    const buy = b.markoutBySide.buy.find((p) => p.ms === horizons[i]);
    const sell = b.markoutBySide.sell.find((p) => p.ms === horizons[i]);
    if (!buy || !sell || buy.bps === null || sell.bps === null || buy.count < MIN_SAMPLES || sell.count < MIN_SAMPLES) continue;
    const gap = Math.abs(buy.bps - sell.bps);
    if (gap > ASYMMETRY_BPS) {
      return html`<span class="badge badge--pause" title="|buy − sell| markout at ${fmtHorizon(horizons[i])}"
        >ONE-SIDED ${gap.toFixed(1)}bps @ ${fmtHorizon(horizons[i])}</span
      >`;
    }
    return '';
  }
  return '';
}

function bookCard(b: MmBookSnapshot): SafeHtml {
  const label = b.source ? `${b.symbol}·${b.source}` : b.symbol;
  // F3 on the same card: cause → effect → outcome on one screen (spec §2).
  const f3 = b.toxicity
    ? html`<span class="dim">F3 widen ${b.toxicity.widenSteps}/tighten ${b.toxicity.tightenSteps} · scale ${b.toxicity.lastScale.toFixed(2)} (max ${b.toxicity.maxScale.toFixed(2)})</span>`
    : html`<span class="dim">F3 off — half-spread unscaled</span>`;
  return html`
    <div class="book-card">
      <div class="book-card-h">
        <span class="mono book-sym">${label}</span>
        ${b.warm ? '' : html`<span class="badge badge--paper">WARMING</span>`}
        ${asymmetryFlag(b)}
      </div>
      ${curveRow('all', b.markout, b.fills)}
      ${curveRow('buy', b.markoutBySide.buy, b.bidFills)}
      ${curveRow('sell', b.markoutBySide.sell, b.askFills)}
      <div class="book-foot">${f3}</div>
    </div>
  `;
}

/** Fill-count-weighted desk-average markout per horizon (only books that traded). */
export function deskAverageMarkout(books: MmBookSnapshot[]): Array<{ ms: number; bps: number; count: number }> {
  const acc = new Map<number, { sum: number; count: number }>();
  for (const b of books) {
    for (const p of b.markout) {
      if (p.count === 0 || p.bps === null) continue;
      const a = acc.get(p.ms) ?? { sum: 0, count: 0 };
      a.sum += p.bps * p.count;
      a.count += p.count;
      acc.set(p.ms, a);
    }
  }
  return [...acc.entries()].sort((x, y) => x[0] - y[0]).map(([ms, a]) => ({ ms, bps: a.sum / a.count, count: a.count }));
}

/** The SSE-refreshed live region: desk strip + per-book cards. */
export function renderMarkoutLive(snap: MmPortfolioSnapshot): SafeHtml {
  const desk = deskAverageMarkout(snap.books);
  const totalFills = snap.books.reduce((n, b) => n + b.fills, 0);
  const deskCells = desk.length
    ? raw(
        desk
          .map(
            (p) => html`
              <div class="stat">
                <span class="stat-k">avg markout @ ${fmtHorizon(p.ms)}</span>
                <span class="stat-v mono ${p.count < MIN_SAMPLES ? 'dim' : bpsClass(p.bps)}"
                  >${p.bps >= 0 ? '+' : '−'}${Math.abs(p.bps).toFixed(2)}bps <span class="stat-sub">${p.count} fills</span></span
                >
              </div>
            `.value,
          )
          .join(''),
      )
    : html`<div class="stat"><span class="stat-k">avg markout</span><span class="stat-v dim">no fills yet</span></div>`;
  const cards = snap.books.length
    ? raw(snap.books.map((b) => bookCard(b).value).join(''))
    : html`<div class="empty dim">no books launched — the desk has nothing to mark out</div>`;
  return html`
    <section class="stat-grid">
      <div class="stat"><span class="stat-k">desk fills</span><span class="stat-v mono">${totalFills}</span></div>
      ${deskCells}
    </section>
    <section class="book-cards book-cards--wide">${cards}</section>
    <p class="dim hint">
      avg per-fill markout vs the fair mid at fill time; green = the move went our way, red = picked off.
      A curve sinking with horizon = informed flow; flat after 1s = micro-price doing its job.
      Counts &lt; ${MIN_SAMPLES}/side are noise — wait (those cells render dim).
    </p>
  `;
}

/** The full /desk/markout document. */
export function renderMarkoutPage(snap: MmPortfolioSnapshot): string {
  const body = html`
    <h1 class="page-title">Markout / TCA — am I getting picked off?</h1>
    <desk-feed src="/desk/markout/stream" target="markout-live">
      <div id="markout-live">${renderMarkoutLive(snap)}</div>
    </desk-feed>
  `;
  return pageShell({ title: 'Meridian · markout', activeHref: '/desk/markout', body: raw(body.value) });
}
