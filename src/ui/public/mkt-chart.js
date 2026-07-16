// <mkt-chart src="/desk/mm/chart?book=BTC" refresh="60" defer> — the shared chart
// component (UI_REWRITE_PLAN_III P1). Pure VISUALIZATION: it fetches a server-built
// ChartSpec (src/ui/render/chart-spec.ts) and renders it verbatim with the vendored
// TradingView Lightweight Charts™ v5 (Apache-2.0; the library's attribution logo is
// kept on). Every number, color, band and marker is decided server-side — this file
// computes no business value (CLAUDE.md §1; same doctrine as <nav-spark>).
//
// Behaviour:
//   - `defer`: when inside a <details> drawer, loading waits for the drawer to open.
//   - `refresh="60"`: re-fetches while visible; same-shape specs update in place
//     (zoom preserved), a changed shape rebuilds.
//   - Honest states: {enabled:false} renders the server's reason; a fetch error says
//     "chart data unavailable" — never an empty axis pretending to be data.
//   - The chart library is lazy-loaded once per page, only when a chart is actually
//     shown, so chartless pages stay light.

const LIB_SRC = '/ui/lightweight-charts.js';
const DEFAULT_PANEL_PX = 140;

let libPromise = null;
function ensureLib() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_SRC;
      s.onload = () => resolve(window.LightweightCharts);
      s.onerror = () => reject(new Error('chart library failed to load'));
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Stable signature of a spec's shape — same shape ⇒ update data in place. */
function shapeSig(spec) {
  return spec.panels.map((p) => p.series.map((s) => s.type + ':' + s.name).join('|')).join('||');
}

function seriesOptions(LWC, s) {
  const common = { priceLineVisible: false, lastValueVisible: true };
  // Server-sent axis hints: 'volume' compacts to K/M; precision sets price decimals.
  if (s.format === 'volume') common.priceFormat = { type: 'volume' };
  else if (typeof s.precision === 'number') common.priceFormat = { type: 'price', precision: s.precision, minMove: Math.pow(10, -s.precision) };
  if (s.type === 'area') {
    return { ...common, lineColor: s.color, lineWidth: 2, topColor: s.color + '4D', bottomColor: s.color + '00' };
  }
  if (s.type === 'histogram') {
    return { ...common, color: s.color, base: 0, lastValueVisible: false };
  }
  if (s.type === 'candlestick') {
    return {
      ...common,
      upColor: s.upColor,
      downColor: s.downColor,
      wickUpColor: s.upColor,
      wickDownColor: s.downColor,
      borderVisible: false,
    };
  }
  return { ...common, color: s.color, lineWidth: 2 };
}

function seriesCtor(LWC, type) {
  if (type === 'area') return LWC.AreaSeries;
  if (type === 'histogram') return LWC.HistogramSeries;
  if (type === 'candlestick') return LWC.CandlestickSeries;
  return LWC.LineSeries;
}

class MktChart extends HTMLElement {
  connectedCallback() {
    this._src = this.getAttribute('src') || '';
    this._refreshS = Number(this.getAttribute('refresh') || '0');
    this._loaded = false;
    this.innerHTML = '<div class="mkt-note dim">chart loads when opened…</div>';
    const drawer = this.hasAttribute('defer') ? this.closest('details') : null;
    if (drawer && !drawer.open) {
      this._onToggle = () => {
        if (drawer.open) this.load();
      };
      drawer.addEventListener('toggle', this._onToggle);
    } else {
      this.load();
    }
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._ro) this._ro.disconnect();
    if (this._chart) this._chart.remove();
    this._chart = null;
  }

  async load() {
    if (this._loaded) return;
    this._loaded = true;
    this.innerHTML = '<div class="mkt-note dim">loading chart…</div>';
    try {
      await ensureLib();
      await this.refresh();
      if (this._refreshS > 0) {
        this._timer = setInterval(() => {
          if (!document.hidden) this.refresh().catch(() => {});
        }, this._refreshS * 1000);
      }
    } catch (e) {
      this.innerHTML = '<div class="mkt-note dim">chart data unavailable — ' + esc(e && e.message ? e.message : 'fetch failed') + '</div>';
    }
  }

  async refresh() {
    const res = await fetch(this._src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const spec = await res.json();
    if (!spec || spec.enabled === false) {
      if (this._chart) {
        this._chart.remove();
        this._chart = null;
      }
      this.innerHTML = '<div class="mkt-note dim">' + esc(spec && spec.reason ? spec.reason : 'no chart data') + '</div>';
      return;
    }
    if (this._chart && this._sig === shapeSig(spec)) {
      this.updateData(spec);
    } else {
      this.build(spec);
    }
  }

  /** Full (re)build: header + legend + chart with one pane per panel. */
  build(spec) {
    const LWC = window.LightweightCharts;
    if (this._chart) {
      this._chart.remove();
      this._chart = null;
    }
    if (this._ro) this._ro.disconnect();
    this._sig = shapeSig(spec);

    const legend = spec.panels
      .map((p) => {
        const dots = p.series.map((s) => '<span class="mkt-lg"><i style="background:' + esc(s.color) + '"></i>' + esc(s.name) + '</span>').join('');
        return '<div class="mkt-lgrow"><span class="mkt-lgtitle">' + esc(p.title) + '</span>' + dots + '</div>';
      })
      .join('');
    this.innerHTML =
      '<div class="mkt-title mono">' + esc(spec.title) + '</div>' +
      '<div class="mkt-legend">' + legend + '</div>' +
      '<div class="mkt-plot"></div>' +
      (spec.note ? '<div class="mkt-note dim">' + esc(spec.note) + '</div>' : '');
    const plot = this.querySelector('.mkt-plot');

    const heights = spec.panels.map((p, i) => p.heightPx || (i === 0 ? 220 : DEFAULT_PANEL_PX));
    const total = heights.reduce((a, b) => a + b, 0);
    const chart = LWC.createChart(plot, {
      width: plot.clientWidth || this.clientWidth || 600,
      height: total,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#6e7681', fontSize: 10 },
      grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#21262d' },
      rightPriceScale: { borderColor: '#21262d' },
      crosshair: { mode: 0 },
    });
    this._chart = chart;
    this._series = []; // [{api, markersApi, spec}]

    spec.panels.forEach((panel, paneIdx) => {
      for (const s of panel.series) {
        const api = chart.addSeries(seriesCtor(LWC, s.type), seriesOptions(LWC, s), paneIdx);
        api.setData(s.data);
        for (const pl of s.priceLines || []) {
          api.createPriceLine({
            price: pl.value,
            color: pl.color,
            lineWidth: 1,
            lineStyle: pl.dashed ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
            axisLabelVisible: true,
            title: pl.title,
          });
        }
        const markersApi = s.markers && s.markers.length ? LWC.createSeriesMarkers(api, s.markers) : null;
        this._series.push({ api, markersApi, name: s.name });
      }
    });

    // Pane heights via stretch factors (v5 panes API).
    const panes = chart.panes();
    heights.forEach((h, i) => {
      if (panes[i] && panes[i].setStretchFactor) panes[i].setStretchFactor(h);
    });

    chart.timeScale().fitContent();
    this.attachTooltip(plot, chart);
    this._ro = new ResizeObserver(() => {
      if (this._chart) this._chart.applyOptions({ width: plot.clientWidth });
    });
    this._ro.observe(this);
  }

  /** Same-shape refresh: swap data + markers in place, preserving the user's zoom. */
  updateData(spec) {
    let i = 0;
    for (const panel of spec.panels) {
      for (const s of panel.series) {
        const h = this._series[i++];
        if (!h) continue;
        h.api.setData(s.data);
        if (h.markersApi) h.markersApi.setMarkers(s.markers || []);
      }
    }
  }

  /** Crosshair value readout — a floating row of "name value" for the hovered time. */
  attachTooltip(plot, chart) {
    const tip = document.createElement('div');
    tip.className = 'mkt-tip mono';
    tip.style.display = 'none';
    plot.appendChild(tip);
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point || !param.seriesData) {
        tip.style.display = 'none';
        return;
      }
      const rows = [];
      for (const h of this._series) {
        const d = param.seriesData.get(h.api);
        if (!d) continue;
        const v = typeof d.value === 'number' ? d.value : d.close;
        if (typeof v !== 'number') continue;
        rows.push('<span class="mkt-tr">' + esc(h.name) + ' <b>' + v.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '</b></span>');
      }
      if (!rows.length) {
        tip.style.display = 'none';
        return;
      }
      const t = new Date(param.time * 1000).toISOString().slice(5, 16).replace('T', ' ');
      tip.innerHTML = '<span class="mkt-tr dim">' + t + 'Z</span>' + rows.join('');
      tip.style.display = 'block';
      const x = Math.min(Math.max(param.point.x + 12, 0), plot.clientWidth - tip.offsetWidth - 4);
      tip.style.left = x + 'px';
      tip.style.top = Math.max(param.point.y - tip.offsetHeight - 8, 0) + 'px';
    });
  }
}

customElements.define('mkt-chart', MktChart);
