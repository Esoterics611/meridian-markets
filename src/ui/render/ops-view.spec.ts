import { renderOpsLive, renderActionPalette, renderOpsPage, OpsState } from './ops-view';
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

function state(over: Partial<OpsState> = {}): OpsState {
  return {
    uptimeSeconds: 3723,
    readiness: ready(),
    persistEnabled: true,
    dbReachable: true,
    mm: mmSnap(),
    lastTickAgeMs: 800,
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
});

describe('renderActionPalette', () => {
  it('wires each button to the correct existing control-plane endpoint', () => {
    const h = renderActionPalette().value;
    expect(h).toContain('endpoint="/api/market-making/start"');
    expect(h).toContain('endpoint="/api/market-making/stop"');
    expect(h).toContain('endpoint="/api/market-making/flatten"');
  });

  it('guards the flatten kill switch with a confirm prompt', () => {
    const h = renderActionPalette().value;
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
