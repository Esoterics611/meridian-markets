// <depth-ladder src="/api/market-data/l2/stream?symbol=BTC&venue=hyperliquid" rows="14">
// — the live order-book ladder (UI_REWRITE_PLAN_III P2; rebuilt side-by-side after
// the 2026-07-16 trader review: bids ‖ asks in two mirrored columns with prices on
// the inner edges — the classic DOM read — instead of a 40-row stacked tower).
//
// Pure VISUALIZATION: it opens the server's SSE depth feed and paints each frame.
// Bids green (left), asks red (right), bar length ∝ resting size growing outward,
// the spread chip in the center, OUR resting quotes marked on their levels. Price
// precision is TICK-AWARE (derived from the level spacing each frame) so distinct
// levels never collapse into duplicate labels (the "76.08 × 6" defect). Every
// number comes from the server frame; this file computes nothing but pixels.
// Honest states: {enabled:false} renders the server's reason; a dropped stream
// dims the ladder (stale = don't trust), exactly like <desk-feed>.

const ROW_H = 18;
const GUTTER = 14; // center gap between the two half-columns
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const BID = '#3fb950';
const ASK = '#f85149';
const OURS = '#58a6ff';
const INK = '#c9d1d9';
const DIM = '#6e7681';
const DEFAULT_ROWS = 14;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtSz(sz) {
  if (sz >= 1000) return (sz / 1000).toFixed(1) + 'k';
  return sz >= 100 ? sz.toFixed(0) : sz >= 1 ? sz.toFixed(2) : sz.toFixed(4);
}

/** Tick-aware decimals: the smallest positive gap between adjacent levels sets the
 *  precision, so 76.083 and 76.084 never both print as "76.08". */
function tickDecimals(levels) {
  let minGap = Infinity;
  for (const side of levels) {
    for (let i = 1; i < side.length; i++) {
      const gap = Math.abs(side[i].px - side[i - 1].px);
      if (gap > 1e-12 && gap < minGap) minGap = gap;
    }
  }
  if (!Number.isFinite(minGap)) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(minGap) - 1e-9)));
}

class DepthLadder extends HTMLElement {
  connectedCallback() {
    this._rows = Math.max(5, Math.min(20, Number(this.getAttribute('rows')) || DEFAULT_ROWS));
    this.innerHTML =
      '<div class="depth-head mono"><span class="depth-bid">—</span><span class="depth-spread dim">spread —</span><span class="depth-ask">—</span></div>' +
      '<canvas class="depth-canvas"></canvas>' +
      '<div class="depth-note dim">connecting to the depth feed…</div>';
    this._canvas = this.querySelector('canvas');
    this._head = this.querySelector('.depth-head');
    this._note = this.querySelector('.depth-note');
    const src = this.getAttribute('src');
    if (!src) {
      this._note.textContent = 'no src attribute — nothing to draw';
      return;
    }
    this._es = new EventSource(src);
    this._es.onmessage = (ev) => {
      try {
        this.classList.remove('stale');
        this.draw(JSON.parse(ev.data));
      } catch {
        /* skip a malformed frame; the next one repaints */
      }
    };
    this._es.onerror = () => {
      // EventSource auto-reconnects; meanwhile the ladder dims (stale = don't trust).
      this.classList.add('stale');
    };
  }

  disconnectedCallback() {
    if (this._es) this._es.close();
  }

  draw(frame) {
    if (!frame || frame.enabled === false) {
      this._canvas.style.display = 'none';
      this._head.style.display = 'none';
      this._note.textContent = frame && frame.reason ? frame.reason : 'no depth data';
      return;
    }
    const bids = (frame.bids || []).slice(0, this._rows);
    const asks = (frame.asks || []).slice(0, this._rows);
    if (!bids.length || !asks.length) {
      this._canvas.style.display = 'none';
      this._note.textContent = 'empty book frame';
      return;
    }
    this._canvas.style.display = 'block';
    this._head.style.display = 'flex';

    const dp = tickDecimals([bids, asks]);
    const fmtPx = (px) => px.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

    const bestBid = bids[0].px;
    const bestAsk = asks[0].px;
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0;
    this._head.innerHTML =
      '<span class="depth-bid">bids (buy) · best ' + esc(fmtPx(bestBid)) + '</span>' +
      '<span class="depth-spread dim">spread ' + spreadBps.toFixed(2) + ' bps</span>' +
      '<span class="depth-ask">asks (sell) · best ' + esc(fmtPx(bestAsk)) + '</span>';
    this._note.textContent =
      frame.symbol + ' · ' + frame.venue + ' — top ' + Math.max(bids.length, asks.length) + ' of 20 levels/side · ~1 frame/s · size bars grow outward' +
      (frame.ourBid !== undefined || frame.ourAsk !== undefined ? ' · ● = our resting quote' : '');

    // ── the side-by-side DOM: [size | BID px] ‖ [ASK px | size], bars outward ──
    const w = this.clientWidth || 380;
    const half = (w - GUTTER) / 2;
    const rows = Math.max(bids.length, asks.length);
    const h = rows * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    const cv = this._canvas;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const maxSz = Math.max(...bids.map((l) => l.sz), ...asks.map((l) => l.sz)) || 1;
    const barMax = half - 8;

    // Our-quote level match: nearest level within a third of the min tick gap.
    const tick = Math.pow(10, -dp);
    const matchIdx = (levels, px) => {
      if (px === undefined) return -1;
      let bi = -1;
      let bd = Infinity;
      levels.forEach((l, i) => {
        const d = Math.abs(l.px - px);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      return bd <= tick / 2 + 1e-12 ? bi : -1;
    };
    const ourBidIdx = matchIdx(bids, frame.ourBid);
    const ourAskIdx = matchIdx(asks, frame.ourAsk);

    for (let i = 0; i < rows; i++) {
      const y = i * ROW_H;
      const b = bids[i];
      const a = asks[i];
      if (b) {
        // bid bar: anchored at the inner (right) edge of the left half, growing LEFT.
        const bw = Math.max(2, (b.sz / maxSz) * barMax);
        ctx.fillStyle = BID + '30';
        ctx.fillRect(half - bw, y + 2, bw, ROW_H - 4);
        ctx.fillStyle = BID;
        ctx.fillRect(half - 2, y + 2, 2, ROW_H - 4);
        ctx.textAlign = 'right';
        ctx.fillStyle = INK;
        ctx.fillText(fmtPx(b.px), half - 6, y + ROW_H / 2);
        ctx.textAlign = 'left';
        ctx.fillStyle = DIM;
        ctx.fillText(fmtSz(b.sz), 4, y + ROW_H / 2);
        if (i === ourBidIdx) {
          ctx.fillStyle = OURS;
          ctx.beginPath();
          ctx.arc(half + GUTTER / 2 - 3, y + ROW_H / 2, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (a) {
        // ask bar: anchored at the inner (left) edge of the right half, growing RIGHT.
        const x0 = half + GUTTER;
        const aw = Math.max(2, (a.sz / maxSz) * barMax);
        ctx.fillStyle = ASK + '30';
        ctx.fillRect(x0, y + 2, aw, ROW_H - 4);
        ctx.fillStyle = ASK;
        ctx.fillRect(x0, y + 2, 2, ROW_H - 4);
        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        ctx.fillText(fmtPx(a.px), x0 + 6, y + ROW_H / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = DIM;
        ctx.fillText(fmtSz(a.sz), w - 4, y + ROW_H / 2);
        if (i === ourAskIdx) {
          ctx.fillStyle = OURS;
          ctx.beginPath();
          ctx.arc(half + GUTTER / 2 + 3, y + ROW_H / 2, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}

customElements.define('depth-ladder', DepthLadder);
