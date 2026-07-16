// <depth-ladder src="/api/market-data/l2/stream?symbol=BTC&venue=hyperliquid"> —
// the live order-book ladder (UI_REWRITE_PLAN_III P2, the teaching centerpiece).
// Pure VISUALIZATION: it opens the server's SSE depth feed and paints each frame —
// bids green below, asks red above, bar length ∝ resting size, the spread gap
// highlighted, and OUR resting quotes marked on their levels. Every number comes
// from the server frame; this file computes nothing but pixels (CLAUDE.md §1).
// Honest states: {enabled:false} renders the server's reason; a dropped stream
// dims the ladder (stale = don't trust), exactly like <desk-feed>.

const ROW_H = 16;
const GAP_H = 22;
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const BID = '#3fb950';
const ASK = '#f85149';
const OURS = '#58a6ff';
const INK = '#c9d1d9';
const DIM = '#6e7681';

function fmtPx(px) {
  const dp = px >= 10 ? 2 : px >= 0.1 ? 4 : 6;
  return px.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtSz(sz) {
  return sz >= 100 ? sz.toFixed(0) : sz >= 1 ? sz.toFixed(2) : sz.toFixed(4);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class DepthLadder extends HTMLElement {
  connectedCallback() {
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
      this._note.textContent = frame && frame.reason ? frame.reason : 'no depth data';
      this._head.style.display = 'none';
      return;
    }
    const bids = frame.bids || [];
    const asks = frame.asks || [];
    if (!bids.length || !asks.length) {
      this._canvas.style.display = 'none';
      this._note.textContent = 'empty book frame';
      return;
    }
    this._canvas.style.display = 'block';
    this._head.style.display = 'flex';
    this._note.textContent =
      frame.symbol + ' · ' + frame.venue + ' · 20×20 · ~1 frame/s (a teaching ladder, not an HFT feed)' +
      (frame.ourBid !== undefined || frame.ourAsk !== undefined ? ' · ▶ = our resting quote' : '');

    const bestBid = bids[0].px;
    const bestAsk = asks[0].px;
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0;
    this._head.innerHTML =
      '<span class="depth-bid">bid ' + esc(fmtPx(bestBid)) + '</span>' +
      '<span class="depth-spread dim">spread ' + spreadBps.toFixed(2) + ' bps</span>' +
      '<span class="depth-ask">ask ' + esc(fmtPx(bestAsk)) + '</span>';

    // Canvas: asks stacked above the gap (worst at top, best just above the gap),
    // bids below (best first). Bar length ∝ size / max size across both sides.
    const w = this.clientWidth || 320;
    const rows = asks.length + bids.length;
    const h = rows * ROW_H + GAP_H;
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
    const barMax = w - 150; // room for px (left) + sz (right) labels

    const row = (y, level, color, isOurs) => {
      const barW = Math.max(2, (level.sz / maxSz) * barMax);
      ctx.fillStyle = color + '38';
      ctx.fillRect(72, y + 2, barW, ROW_H - 4);
      ctx.fillStyle = color;
      ctx.fillRect(72, y + 2, 2, ROW_H - 4);
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPx(level.px), 4, y + ROW_H / 2);
      ctx.fillStyle = DIM;
      ctx.textAlign = 'right';
      ctx.fillText(fmtSz(level.sz), w - 4, y + ROW_H / 2);
      if (isOurs) {
        ctx.fillStyle = OURS;
        ctx.textAlign = 'left';
        ctx.fillText('▶ ours', 76 + barW + 6, y + ROW_H / 2);
      }
    };

    // Nearest-level match for our quotes (server sends exact px; levels are the venue's).
    const nearest = (levels, px) => {
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
      return bd <= mid * 0.001 ? bi : -1; // within 10bps of a level, else unmarked
    };
    const ourAskIdx = nearest(asks, frame.ourAsk);
    const ourBidIdx = nearest(bids, frame.ourBid);

    // Asks: worst (highest) at the top → best just above the gap.
    for (let i = 0; i < asks.length; i++) {
      const y = (asks.length - 1 - i) * ROW_H;
      row(y, asks[i], ASK, i === ourAskIdx);
    }
    // The spread gap.
    const gapY = asks.length * ROW_H;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'center';
    ctx.fillText('— spread ' + spreadBps.toFixed(2) + ' bps —', w / 2, gapY + GAP_H / 2);
    // Bids: best at the top of the lower half.
    for (let i = 0; i < bids.length; i++) {
      const y = gapY + GAP_H + i * ROW_H;
      row(y, bids[i], BID, i === ourBidIdx);
    }
  }
}

customElements.define('depth-ladder', DepthLadder);
