// The /markets terminal (UI_REWRITE_PLAN_III P2) — the market on screen: a live
// header strip, the candle chart with our-quote/fill overlays, the L2 depth
// ladder, and our per-symbol activity tape. The teaching centerpiece: bid, ask,
// spread and the order book, rendered from the same live feeds the desk trades.
//
// Pure renders (unit-tested):
//   renderMarketsStrip(d)  — the SSE-refreshed header strip (price · Δ24h · range · spread).
//   renderMarketsPage(s)   — the full document (picker form, chart, ladder, tape).
import { DeskEvent } from '../../market-making/events/desk-event';
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { appendActivityTape, deskTour, explain, learnIntro, TourStep } from './components';

export interface StripData {
  symbol: string;
  venue: string;
  /** Last trade/mid price (venue-fresh), or null when the feed is unreachable. */
  last: number | null;
  /** 24h change % (vs the window's first open), null when the range read failed. */
  deltaPct: number | null;
  hi: number | null;
  lo: number | null;
  /** Live top-of-book spread in bps (L2 venues only). */
  spreadBps: number | null;
  asOfMs: number;
  /** Honest failure: set ⇒ the strip renders the reason, never stale numbers. */
  error?: string;
}

/** Price formatter: enough digits to be meaningful at any scale, no fake precision. */
export function fmtPx(px: number | null): string {
  if (px === null || !Number.isFinite(px)) return '—';
  const dp = px >= 10 ? 2 : px >= 0.1 ? 4 : 6;
  return px.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** The header strip (inside the page's SSE region — re-rendered every tick). */
export function renderMarketsStrip(d: StripData): SafeHtml {
  if (d.error) {
    return html`
      <section class="stat-grid">
        <div class="stat"><span class="stat-k">${d.symbol} · ${d.venue}</span><span class="stat-v"><span class="badge badge--deny">FEED DOWN</span></span></div>
        <div class="stat"><span class="stat-k">reason</span><span class="stat-v dim">${d.error}</span></div>
      </section>
    `;
  }
  const cls = d.deltaPct === null ? 'flat' : d.deltaPct >= 0 ? 'pos' : 'neg';
  const delta = d.deltaPct === null ? '—' : `${d.deltaPct >= 0 ? '+' : '−'}${Math.abs(d.deltaPct).toFixed(2)}%`;
  return html`
    <section class="stat-grid">
      <div class="stat">
        <span class="stat-k">${d.symbol} · ${d.venue} — last</span>
        <span class="stat-v mono stat-v--big ${cls}">${fmtPx(d.last)}</span>
      </div>
      <div class="stat"><span class="stat-k">24h Δ</span><span class="stat-v mono ${cls}">${delta}</span></div>
      <div class="stat"><span class="stat-k">24h range</span><span class="stat-v mono">${fmtPx(d.lo)} — ${fmtPx(d.hi)}</span></div>
      <div class="stat">
        <span class="stat-k">top-of-book spread ${explain('spread')}</span>
        <span class="stat-v mono">${d.spreadBps === null ? html`<span class="dim" title="spread needs an L2 venue">—</span>` : `${d.spreadBps.toFixed(2)} bps`}</span>
      </div>
      <div class="stat"><span class="stat-k">mode</span><span class="stat-v"><span class="badge badge--paper">PAPER</span></span></div>
    </section>
  `;
}

export interface MarketsPageState {
  symbol: string;
  venue: string;
  hours: number;
  /** Picker options (from the MM market presets for the venue). */
  symbols: string[];
  venues: string[];
  /** Whether the venue can serve an L2 depth ladder. */
  hasL2: boolean;
  strip: StripData;
  events: DeskEvent[];
  cursor: number;
}

const HOURS_OPTIONS = [6, 24, 72, 168];

/** Plain GET form — picking a market reloads the page with the new query (no JS,
 *  no client state; the server renders the chosen market's page). */
function pickerForm(s: MarketsPageState): SafeHtml {
  const symOpts = raw(
    s.symbols.map((x) => html`<option value="${x}" ${x === s.symbol ? 'selected' : ''}>${x}</option>`.value).join(''),
  );
  const venueOpts = raw(
    s.venues.map((v) => html`<option value="${v}" ${v === s.venue ? 'selected' : ''}>${v}</option>`.value).join(''),
  );
  const hourOpts = raw(
    HOURS_OPTIONS.map((h) => html`<option value="${h}" ${h === s.hours ? 'selected' : ''}>${h}h</option>`.value).join(''),
  );
  return html`
    <form class="panel form-row markets-picker" method="get" action="/markets">
      <select class="fld" name="venue">${venueOpts}</select>
      <select class="fld" name="symbol">${symOpts}</select>
      <select class="fld" name="hours">${hourOpts}</select>
      <button class="fld" type="submit">view market</button>
    </form>
  `;
}

/** The /markets guided tour (P3) — the Session-10 lesson, live. */
const MARKETS_TOUR: TourStep[] = [
  { sel: '.markets-picker', text: 'Pick a market: venue, symbol, window. Everything below is that market, live — the same public feeds the paper desk trades on.' },
  { sel: '#markets-strip', text: 'The headline: the last price (on depth venues it is the book’s mid), the 24h move and range, and the live top-of-book spread. If the feed drops, this says FEED DOWN — it never shows stale numbers.' },
  { sel: '.markets-chart', text: 'Price history as candles: each candle is one interval’s open/high/low/close; the pane below is traded volume. When one of our MM books quotes this market, dashed lines mark OUR bid and ask straddling the price.' },
  { sel: '.markets-depth', text: 'The order book, right now: everyone’s resting buy orders (green, left) and sell orders (red, right), sizes as outward bars. There is no single "the price" — there is a best bid, a best ask, and the SPREAD between them. That gap is what a market maker earns.' },
  { sel: '.activity', text: 'Our paper desk’s own fills on this symbol — not the venue’s trades (that tape is honestly marked as not served yet).' },
];

/** The full /markets document. */
export function renderMarketsPage(s: MarketsPageState): string {
  const q = `symbol=${encodeURIComponent(s.symbol)}&venue=${encodeURIComponent(s.venue)}`;
  const depth = s.hasL2
    ? html`<depth-ladder src="/api/market-data/l2/stream?${raw(q)}"></depth-ladder>`
    : html`<p class="dim empty">no depth feed for ${s.venue} — the ladder needs an L2-capable venue (hyperliquid). The candles are still live.</p>`;
  const body = html`
    <h1 class="page-title">Markets — live market terminal ${deskTour(MARKETS_TOUR)}</h1>
    ${learnIntro(
      'One market, live: the chart is price history; the ladder is the order book RIGHT NOW — everyone’s resting buy (green) and sell (red) orders, deepest sizes as the longest bars. The gap between the best of each side is the spread, and earning it is the market-making business the /desk/mm page runs.',
    )}
    ${pickerForm(s)}
    <desk-feed src="/markets/stream?${raw(q)}" target="markets-strip">
      <div id="markets-strip">${renderMarketsStrip(s.strip)}</div>
    </desk-feed>
    <section class="markets-grid">
      <section class="panel markets-chart">
        <div class="panel-h">price · volume — live ${s.venue} klines (+ our quotes/fills when a book runs)</div>
        <mkt-chart src="/markets/chart?${raw(q)}&hours=${s.hours}" refresh="20"></mkt-chart>
      </section>
      <section class="panel markets-depth">
        <div class="panel-h">order book ${explain('order-book')} — L2 depth (bids ‖ asks side-by-side · size bars grow outward · ● our resting quotes)</div>
        ${depth}
      </section>
    </section>
    ${appendActivityTape({
      events: s.events,
      cursor: s.cursor,
      src: '/api/market-making/events',
      book: s.symbol,
      title: `our activity — ${s.symbol}`,
      emptyNote: `no desk activity on ${s.symbol} yet — launch an MM book on it to see fills land here`,
    })}
    <p class="dim hint">
      market prints (the venue's own trade tape) and the quote-history / micro-price overlays are not
      served yet (UI_REWRITE_PLAN_III E6/E7) — nothing here fakes them. The activity tape above is
      OUR paper desk's fills only.
    </p>
  `;
  return pageShell({ title: `Meridian · markets · ${s.symbol}`, activeHref: '/markets', body: raw(body.value) });
}
