// The Operator role page (/ops) — UI_REDESIGN_PROMPT.md §2: process/feed/DB
// health, tick freshness, persistence state, the MM desk status, AND the first
// curated action palette (start/stop/flatten — the kill switch). Read panels
// trace to the engine (readiness probe + MmPortfolioTrader.snapshot()); the
// buttons POST to the EXISTING, validated control-plane endpoints — no new write
// surface, no embedded shell (the brief's §5 verdict).
//
// Two pure exports (the live panels are UNIT TESTED):
//   renderOpsLive(state) — the SSE-refreshed status panels.
//   renderOpsPage(state) — full document: shell + static action palette + live region.
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { ReadinessResult } from '../../telemetry/readiness';
import { html, SafeHtml, raw } from './html';
import { pageShell } from './layout';
import { usd, money, duration, age, mb } from './format';
import { deskControls } from './components';

/** The runtime/telemetry summary — process memory + the live loop counters read
 *  straight from the Prometheus registry (the metrics ledger, DC-3). When telemetry
 *  is off the registry is empty, so `enabled` is false and only memory is shown. */
export interface OpsTelemetry {
  enabled: boolean;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Event-loop lag (s), sampled by the telemetry loop monitor; null when off. */
  eventLoopLagSec: number | null;
  /** MM loop tick counter + overruns ({loop:'mm'}). */
  ticks: number;
  tickOverruns: number;
  /** Mean tick duration (ms) from the tick-duration histogram; null with no ticks. */
  meanTickMs: number | null;
  /** Persistence checkpoint counters ({result:'ok'|'error'}). */
  persistOk: number;
  persistErrors: number;
}

export interface OpsState {
  uptimeSeconds: number;
  readiness: ReadinessResult;
  persistEnabled: boolean;
  /** DB reachability when persistence is on; null when persistence is off. */
  dbReachable: boolean | null;
  mm: MmPortfolioSnapshot;
  /** Age of the MM desk's last completed tick (ms); null if it has never ticked. */
  lastTickAgeMs: number | null;
  telemetry: OpsTelemetry;
}

function okBadge(ok: boolean, yes: string, no: string): SafeHtml {
  return ok ? html`<span class="badge badge--allow">${yes}</span>` : html`<span class="badge badge--deny">${no}</span>`;
}

function checkRows(r: ReadinessResult): SafeHtml {
  if (r.checks.length === 0) {
    return html`<li class="check check--ok dim">idle — nothing running, ready to accept work</li>`;
  }
  return raw(
    r.checks
      .map((c) => html`<li class="check check--${c.ok ? 'ok' : 'fail'}">${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}</li>`.value)
      .join(''),
  );
}

/** The telemetry / runtime panel — process memory + the live loop counters. */
function telemetryPanel(t: OpsTelemetry, persistEnabled: boolean): SafeHtml {
  const status = t.enabled
    ? html`<span class="badge badge--allow">ENABLED</span>`
    : html`<span class="badge badge--paper">OFF</span>`;
  const lag = t.eventLoopLagSec === null ? '—' : `${(t.eventLoopLagSec * 1000).toFixed(1)} ms`;
  const meanTick = t.meanTickMs === null ? '—' : `${t.meanTickMs.toFixed(1)} ms`;
  // The loop counters only mean something once telemetry is wired (PrometheusTelemetry
  // populates them); with it off we don't pretend a 0 is a real measurement.
  const counters = t.enabled
    ? html`
        <div class="kv"><span class="k">mm ticks</span><span class="v mono">${t.ticks} <span class="dim">· mean ${meanTick}</span></span></div>
        <div class="kv"><span class="k">tick overruns</span><span class="v mono ${t.tickOverruns > 0 ? 'neg' : ''}">${t.tickOverruns}</span></div>
        <div class="kv"><span class="k">event-loop lag</span><span class="v mono">${lag}</span></div>
        ${persistEnabled
          ? html`<div class="kv"><span class="k">persist ok/err</span><span class="v mono">${t.persistOk} / <span class="${t.persistErrors > 0 ? 'neg' : ''}">${t.persistErrors}</span></span></div>`
          : ''}
      `
    : html`<div class="kv dim"><span class="k">loop counters</span><span class="v">set TELEMETRY_ENABLED=true</span></div>`;
  return html`
    <div class="panel">
      <div class="panel-h">telemetry / runtime</div>
      <div class="kv"><span class="k">telemetry</span>${status}</div>
      <div class="kv"><span class="k">rss</span><span class="v mono">${mb(t.rssBytes)}</span></div>
      <div class="kv"><span class="k">heap used/total</span><span class="v mono">${mb(t.heapUsedBytes)} / ${mb(t.heapTotalBytes)}</span></div>
      ${counters}
      <div class="kv"><span class="k">scrape</span><a class="metrics-link" href="/metrics">/metrics →</a></div>
    </div>
  `;
}

/** The live status panels — re-rendered on each SSE tick into `#ops-live`. */
export function renderOpsLive(state: OpsState): SafeHtml {
  const { mm, readiness } = state;
  const dbDetail = !state.persistEnabled
    ? 'n/a (persistence off)'
    : state.dbReachable
      ? 'reachable'
      : 'unreachable';

  return html`
    <section class="ops-grid">
      <div class="panel">
        <div class="panel-h">process</div>
        <div class="kv"><span class="k">readiness</span>${okBadge(readiness.ready, 'READY', 'NOT READY')}</div>
        <div class="kv"><span class="k">uptime</span><span class="v mono">${duration(state.uptimeSeconds)}</span></div>
        <ul class="checks">${checkRows(readiness)}</ul>
      </div>

      <div class="panel">
        <div class="panel-h">market-making desk</div>
        <div class="kv"><span class="k">loop</span>${mm.running ? okBadge(true, 'RUNNING', '') : html`<span class="badge badge--pause">STOPPED</span>`}</div>
        <div class="kv"><span class="k">books</span><span class="v mono">${mm.bookCount}</span></div>
        <div class="kv"><span class="k">last tick</span><span class="v mono">${age(state.lastTickAgeMs)}</span></div>
        <div class="kv"><span class="k">desk nav</span><span class="v mono">${usd(mm.equityUnits)}</span></div>
        <div class="kv"><span class="k">net p&amp;l</span><span class="v mono ${BigInt(mm.netPnlUnits) >= 0n ? 'pos' : 'neg'}">${money(mm.netPnlUnits)}</span></div>
      </div>

      <div class="panel">
        <div class="panel-h">persistence</div>
        <div class="kv"><span class="k">MM_PERSIST</span>${state.persistEnabled ? okBadge(true, 'ON', '') : html`<span class="badge badge--paper">OFF</span>`}</div>
        <div class="kv"><span class="k">database</span><span class="v">${dbDetail}</span></div>
      </div>

      ${telemetryPanel(state.telemetry, state.persistEnabled)}
    </section>

    <p class="asof dim">streaming · paper-only · health from <code>/health/ready</code>, desk from <code>/api/market-making/snapshot</code>, runtime from <code>/metrics</code></p>
  `;
}

/** The full /ops document: shell + the shared desk-control palette + the live status region. */
export function renderOpsPage(state: OpsState): string {
  const body = html`
    <h1 class="page-title">Operator — desk controls &amp; health</h1>
    ${deskControls()}
    <desk-feed src="/ops/stream" target="ops-live">
      <div id="ops-live">${renderOpsLive(state)}</div>
    </desk-feed>
  `;
  return pageShell({ title: 'Meridian · ops', activeHref: '/ops', body: raw(body.value) });
}
