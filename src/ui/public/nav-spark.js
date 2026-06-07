// <nav-spark book="BTC" hours="24" metric="equity" label="desk equity"> — the shared
// equity-curve sparkline. It fetches the durable MM NAV history (Telemetry P3) and
// draws it as an inline SVG. Pure VISUALIZATION: the engine owns the equity curve
// (every point comes from /api/market-making/nav); the component only maps those
// points into a viewbox — it computes no business number (CLAUDE.md §1). When
// MM_PERSIST is off the endpoint answers {enabled:false} and we show that honestly,
// not an empty flat line pretending the desk made nothing.
//
// It self-refreshes on a gentle interval, so it must live OUTSIDE any <desk-feed>
// SSE region (an SSE tick would otherwise recreate the element and restart its fetch).

const MICROS = 1e6;

function unitsToNum(units) {
  // 6-decimal integer units (string) → float dollars. BigInt keeps big NAVs exact.
  const v = BigInt(units);
  return Number(v) / MICROS;
}
function fmtUsd(units) {
  return '$' + unitsToNum(units).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(units) {
  const v = BigInt(units);
  const n = Number(v < 0n ? -v : v) / MICROS;
  return (v < 0n ? '−' : '+') + '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const REFRESH_MS = 30000;

class NavSpark extends HTMLElement {
  connectedCallback() {
    this._book = this.getAttribute('book') || '';
    this._hours = this.getAttribute('hours') || '24';
    this._metric = this.getAttribute('metric') === 'net' ? 'netPnlUnits' : 'equityUnits';
    this._label = this.getAttribute('label') || (this._book ? this._book + ' equity' : 'desk equity');
    this.render('<span class="spark-note dim">loading NAV…</span>');
    this.refresh();
    this._timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._abort) this._abort.abort();
  }

  async refresh() {
    try {
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      const qs = new URLSearchParams({ hours: this._hours });
      if (this._book) qs.set('book', this._book);
      const res = await fetch('/api/market-making/nav?' + qs.toString(), { signal: this._abort.signal });
      this.draw(await res.json());
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      this.render('<span class="spark-note dim">NAV unavailable</span>');
    }
  }

  draw(data) {
    if (!data || data.enabled === false) {
      this.render('<span class="spark-note dim">durable NAV off — set MM_PERSIST (needs Postgres)</span>');
      return;
    }
    const pts = Array.isArray(data.points) ? data.points : [];
    if (pts.length < 2) {
      this.render('<span class="spark-note dim">no NAV history yet — needs a few persisted samples</span>');
      return;
    }
    const vals = pts.map((p) => unitsToNum(p[this._metric]));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 240;
    const H = 40;
    const pad = 2;
    const coords = vals.map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
      const y = H - pad - ((v - min) / span) * (H - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const firstUnits = pts[0][this._metric];
    const lastUnits = pts[pts.length - 1][this._metric];
    const deltaUnits = (BigInt(lastUnits) - BigInt(firstUnits)).toString();
    const cls = BigInt(deltaUnits) >= 0n ? 'pos' : 'neg';
    const headline = this._metric === 'equityUnits' ? fmtUsd(lastUnits) : fmtSigned(lastUnits);
    this.render(
      '<div class="spark-h">' +
        '<span class="spark-label dim">' + esc(this._label) + '</span>' +
        '<span class="spark-val mono ' + cls + '">' + esc(headline) + '</span>' +
        '<span class="spark-delta mono ' + cls + '">' + esc(fmtSigned(deltaUnits)) + ' · ' + esc(data.hours || this._hours) + 'h</span>' +
      '</div>' +
      '<svg class="spark-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="equity sparkline">' +
        '<polyline class="' + cls + '" fill="none" stroke-width="1.25" points="' + coords.join(' ') + '" />' +
      '</svg>',
    );
  }

  render(inner) {
    this.innerHTML = inner;
  }
}

customElements.define('nav-spark', NavSpark);
