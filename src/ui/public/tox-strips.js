// <tox-strips src="/api/market-making/snapshot" minutes="15"> — the per-book
// VPIN + F3-scale recent-history strips (TRADER_UI_SPEC.md §3, the VisualHFT-
// equivalent view). Pure VISUALIZATION: every sample comes from the engine's
// snapshot endpoint; the component only buffers and draws — it computes no
// business number (CLAUDE.md §1). The ring buffer lives client-side because the
// engine deliberately does not persist a VPIN history (it is a live gauge);
// the strip therefore starts empty on page load and fills as you watch.
//
// It self-polls, so it must live OUTSIDE any <desk-feed> SSE region (an SSE
// tick would recreate the element and wipe the buffer).

const POLL_MS = 2500;
const W = 460;
const H = 34;
const PAD = 2;
const F3_MAX = 3; // engine cap: F3 scale ∈ [0.5, 3] — draw it on a fixed honest axis

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function polyline(points, n, yOf, cls, dashed) {
  if (n < 2) return '';
  const coords = [];
  for (let i = 0; i < n; i++) {
    const x = PAD + (i / (n - 1)) * (W - 2 * PAD);
    const y = H - PAD - Math.max(0, Math.min(1, yOf(points[i]))) * (H - 2 * PAD);
    coords.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return (
    '<polyline class="' + cls + '" fill="none" stroke-width="1"' +
    (dashed ? ' stroke-dasharray="3,2"' : '') +
    ' points="' + coords.join(' ') + '" />'
  );
}

class ToxStrips extends HTMLElement {
  connectedCallback() {
    this._src = this.getAttribute('src') || '/api/market-making/snapshot';
    const minutes = Number(this.getAttribute('minutes') || '15');
    this._cap = Math.max(2, Math.round((minutes * 60000) / POLL_MS));
    this._hist = new Map(); // symbol -> [{vpin, scale, warmed}]
    this.innerHTML = '<span class="spark-note dim">collecting — the strip fills as you watch (no persisted VPIN history)</span>';
    this.poll();
    this._timer = setInterval(() => this.poll(), POLL_MS);
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._abort) this._abort.abort();
  }

  async poll() {
    try {
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      const res = await fetch(this._src, { signal: this._abort.signal });
      const snap = await res.json();
      const books = Array.isArray(snap.books) ? snap.books : [];
      const seen = new Set();
      for (const b of books) {
        seen.add(b.symbol);
        const buf = this._hist.get(b.symbol) || [];
        buf.push({
          vpin: typeof b.vpin === 'number' ? b.vpin : 0,
          scale: b.toxicity ? b.toxicity.lastScale : null,
          warmed: b.vpinBuckets >= b.vpinWindowBuckets,
        });
        if (buf.length > this._cap) buf.shift();
        this._hist.set(b.symbol, buf);
      }
      for (const sym of [...this._hist.keys()]) if (!seen.has(sym)) this._hist.delete(sym); // removed book
      this.draw(books);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      this.innerHTML = '<span class="spark-note dim">snapshot unavailable</span>';
    }
  }

  draw(books) {
    if (!books.length) {
      this.innerHTML = '<span class="spark-note dim">no books launched</span>';
      return;
    }
    let out = '';
    for (const b of books) {
      const buf = this._hist.get(b.symbol) || [];
      const n = buf.length;
      const last = n ? buf[n - 1] : null;
      const vpinLine = polyline(buf, n, (p) => p.vpin, 'tox-line--vpin', false);
      const hasScale = buf.some((p) => p.scale !== null);
      const scaleLine = hasScale ? polyline(buf, n, (p) => (p.scale === null ? 0 : p.scale / F3_MAX), 'tox-line--scale', true) : '';
      const warmNote = last && !last.warmed ? ' <span class="dim">(vpin warming)</span>' : '';
      const head =
        '<span class="spark-label dim">' + esc(b.symbol) + '</span>' +
        (last
          ? ' <span class="mono">vpin ' + esc(last.vpin.toFixed(2)) + '</span>' +
            (last.scale !== null ? ' <span class="mono dim">· F3 ×' + esc(last.scale.toFixed(2)) + '</span>' : ' <span class="dim">· F3 off</span>') +
            warmNote
          : '');
      out +=
        '<div class="tox-strip">' +
        '<div class="spark-h">' + head + '</div>' +
        '<svg class="tox-strip-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
        esc(b.symbol) + ' toxicity history">' + vpinLine + scaleLine + '</svg>' +
        '</div>';
    }
    this.innerHTML = out;
  }
}

customElements.define('tox-strips', ToxStrips);
