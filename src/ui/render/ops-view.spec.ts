import { renderOpsLive, renderOpsPage, OpsState, OpsTelemetry } from './ops-view';
import { deskControls } from './components';
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { ReadinessResult } from '../../telemetry/readiness';

function mmSnap(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: true,
    bookCount: 2,
    capitalUnits: '200000000000',
    equityUnits: '201500000000', // $201,500.00
    realisedPnlUnits: '1000000000',
    unrealisedPnlUnits: '500000000',
    feesUnits: '-5000000',
    fundingUnits: '0',
    netPnlUnits: '1500000000', // +$1,500.00
    books: [],
    ...over,
  };
}

function ready(over: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    ready: true,
    checks: [
      { name: 'tick_loop', ok: true, detail: 'last tick 800ms ago (limit 6000ms)' },
      { name: 'feed', ok: true, detail: 'freshest bar 1200ms ago (limit 90000ms)' },
    ],
    ...over,
  };
}

function telemetry(over: Partial<OpsTelemetry> = {}): OpsTelemetry {
  return {
    enabled: true,
    rssBytes: 134217728, // 128.0 MB
    heapUsedBytes: 67108864, // 64.0 MB
    heapTotalBytes: 100663296, // 96.0 MB
    eventLoopLagSec: 0.0021,
    ticks: 1200,
    tickOverruns: 0,
    meanTickMs: 4.2,
    persistOk: 30,
    persistErrors: 0,
    ...over,
  };
}

function state(over: Partial<OpsState> = {}): OpsState {
  return {
    uptimeSeconds: 3723,
    readiness: ready(),
    persistEnabled: true,
    dbReachable: true,
    mm: mmSnap(),
    lastTickAgeMs: 800,
    telemetry: telemetry(),
    ...over,
  };
}

describe('renderOpsLive', () => {
  it('renders the process panel: readiness verdict, uptime and checks', () => {
    const h = renderOpsLive(state()).value;
    expect(h).toContain('readiness');
    expect(h).toContain('>READY<');
    expect(h).toContain('1h 02m'); // duration(3723)
    expect(h).toContain('tick_loop');
    expect(h).toContain('check--ok');
  });

  it('shows NOT READY and a failing check when readiness fails', () => {
    const h = renderOpsLive(
      state({
        readiness: { ready: false, checks: [{ name: 'database', ok: false, detail: 'unreachable' }] },
      }),
    ).value;
    expect(h).toContain('>NOT READY<');
    expect(h).toContain('check--fail');
    expect(h).toContain('database — unreachable');
  });

  it('renders the MM desk panel from the snapshot', () => {
    const h = renderOpsLive(state()).value;
    expect(h).toContain('>RUNNING<');
    expect(h).toContain('$201,500.00'); // desk nav
    expect(h).toContain('+$1,500.00'); // net p&l
    expect(h).toContain('800ms ago'); // last tick age
  });

  it('shows STOPPED when the desk loop is not running', () => {
    const h = renderOpsLive(state({ mm: mmSnap({ running: false }), lastTickAgeMs: null })).value;
    expect(h).toContain('>STOPPED<');
    expect(h).toContain('never'); // last tick never
  });

  it('reports persistence on + database reachable', () => {
    const h = renderOpsLive(state()).value;
    expect(h).toContain('>ON<');
    expect(h).toContain('reachable');
  });

  it('reports persistence off + n/a database', () => {
    const h = renderOpsLive(state({ persistEnabled: false, dbReachable: null, readiness: ready({ checks: [] }) })).value;
    expect(h).toContain('>OFF<');
    expect(h).toContain('n/a (persistence off)');
    expect(h).toContain('idle — nothing running'); // empty checks → honest idle line
  });

  it('renders the telemetry/runtime panel: memory + live loop counters + scrape link', () => {
    const h = renderOpsLive(state()).value;
    expect(h).toContain('telemetry / runtime');
    expect(h).toContain('>ENABLED<');
    expect(h).toContain('128.0 MB'); // rss
    expect(h).toContain('64.0 MB / 96.0 MB'); // heap used / total
    expect(h).toContain('1200'); // mm ticks
    expect(h).toContain('mean 4.2 ms');
    expect(h).toContain('2.1 ms'); // event-loop lag (0.0021s)
    expect(h).toContain('30 / '); // persist ok / err
    expect(h).toContain('href="/metrics"');
  });

  it('does not fabricate loop counters when telemetry is OFF (only memory + the enable hint)', () => {
    const h = renderOpsLive(state({ telemetry: telemetry({ enabled: false, ticks: 0, meanTickMs: null, eventLoopLagSec: null }) })).value;
    expect(h).toContain('telemetry / runtime');
    // the telemetry status badge reads OFF (so does MM_PERSIST=OFF — assert via the hint)
    expect(h).toContain('set TELEMETRY_ENABLED=true');
    expect(h).not.toContain('mm ticks'); // no counter rows when off
    expect(h).toContain('128.0 MB'); // memory still shown (a process stat, not a metric)
  });
});

describe('deskControls', () => {
  it('wires each button to the correct existing control-plane endpoint', () => {
    const h = deskControls().value;
    expect(h).toContain('endpoint="/api/market-making/start"');
    expect(h).toContain('endpoint="/api/market-making/stop"');
    expect(h).toContain('endpoint="/api/market-making/flatten"');
  });

  it('guards the flatten kill switch with a confirm prompt', () => {
    const h = deskControls().value;
    // the flatten button — and only it — carries a confirm attribute
    expect(h).toMatch(/endpoint="\/api\/market-making\/flatten"[\s\S]*confirm=/);
    expect((h.match(/confirm=/g) || []).length).toBe(1);
  });
});

describe('renderOpsPage', () => {
  it('wraps the palette + live region in the shared shell + desk-feed', () => {
    const html = renderOpsPage(state());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('class="action-palette"');
    expect(html).toContain('<desk-feed src="/ops/stream" target="ops-live">');
    expect(html).toContain('id="ops-live"');
    expect(html).toContain('src="/ui/desk-action.js"'); // the action component is loaded
    expect(html).toContain('nav-link--active'); // /ops highlighted in the top bar
  });
});
