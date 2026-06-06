import {
  renderStatArbLive,
  renderStatArbBlotter,
  renderStatArbLaunchForm,
  renderStatArbPage,
  StatArbDeskState,
  BlotterRow,
} from './statarb-desk-view';
import { PortfolioSnapshot, PortfolioBookRow } from '../../execution/live-portfolio-trader';
import { DeskEvent } from '../../market-making/events/desk-event';

function pair(over: Partial<PortfolioBookRow> = {}): PortfolioBookRow {
  return {
    pair: 'ETH/BTC',
    symbolA: 'ETH',
    symbolB: 'BTC',
    strategyId: 'pairs-zscore',
    beta: 0.061,
    feedId: 'binance.spot',
    lastZ: 1.84,
    regime: 'SHORT',
    running: true,
    barsSeen: 240,
    lastBarAt: '2026-06-06T12:00:00.000Z',
    seededBars: 60,
    blockedEntries: 2,
    capitalUnits: '100000000000', // $100,000
    equityUnits: '100450000000',
    realisedPnlUnits: '300000000', // +$300.00
    unrealisedPnlUnits: '150000000', // +$150.00
    position: 'SHORT',
    ...over,
  };
}

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    running: true,
    feedId: 'binance.spot',
    venueId: 'paper',
    pairCount: 1,
    capitalUnits: '100000000000',
    equityUnits: '100450000000',
    realisedPnlUnits: '1000000000', // +$1,000.00
    unrealisedPnlUnits: '234000000', // +$234.00 → net +$1,234.00 → +1.23%
    books: [pair()],
    ...over,
  };
}

function ev(over: Partial<DeskEvent> = {}): DeskEvent {
  return {
    seq: 1,
    ts: Date.parse('2026-06-06T12:00:05.000Z'),
    desk: 'stat-arb',
    kind: 'fill',
    book: 'ETH/BTC',
    source: '',
    message: 'ETH/BTC ▸ entered SHORT @ z=1.84',
    ...over,
  };
}

describe('renderStatArbLive', () => {
  it('renders the desk summary (net = realised + unrealised)', () => {
    const h = renderStatArbLive(snap(), []).value;
    expect(h).toContain('desk nav');
    expect(h).toContain('$100,450.00');
    expect(h).toContain('+$1,234.00'); // 1000 + 234
    expect(h).toContain('+1.23%');
    expect(h).toContain('>RUNNING<');
  });

  it('renders a per-pair card: z / β / regime / position / P&L', () => {
    const h = renderStatArbLive(snap(), []).value;
    expect(h).toContain('ETH/BTC');
    expect(h).toContain('1.84'); // z
    expect(h).toContain('0.061'); // β (3dp)
    expect(h).toContain('SHORT'); // regime + position
    expect(h).toContain('+$300.00'); // realised
    expect(h).toContain('+$150.00'); // unrealised
    expect(h).toContain('blocked 2');
  });

  it('wires the per-pair remove button to the pair it sits on', () => {
    const h = renderStatArbLive(snap(), []).value;
    expect(h).toContain('endpoint="/api/stat-arb/live/portfolio/remove"');
    expect(h).toContain('&quot;pair&quot;:&quot;ETH/BTC&quot;'); // JSON body, html-escaped
    expect(h).toContain('Remove + flatten ETH/BTC?');
  });

  it('colours the position badge by side', () => {
    expect(renderStatArbLive(snap({ books: [pair({ position: 'LONG' })] }), []).value).toContain('badge badge--allow');
    expect(renderStatArbLive(snap({ books: [pair({ position: 'SHORT' })] }), []).value).toContain('badge badge--deny');
    // null position renders FLAT (paper/dim badge)
    const flat = renderStatArbLive(snap({ books: [pair({ position: null })] }), []).value;
    expect(flat).toContain('>FLAT</span>');
  });

  it('renders the activity tape + an honest empty state', () => {
    expect(renderStatArbLive(snap(), [ev()]).value).toContain('entered SHORT');
    const empty = renderStatArbLive(snap({ pairCount: 0, books: [] }), []).value;
    expect(empty).toContain('no pairs launched');
    expect(empty).toContain('no activity yet');
  });
});

describe('renderStatArbBlotter', () => {
  const rows: BlotterRow[] = [
    { pair: 'ETH/BTC', side: 'SHORT', entryZ: 1.84, exitZ: 0.21, pnlUnits: '125000000', closedAt: '2026-06-06T11:30:00.000Z' },
  ];

  it('renders closed trades when persistence is available', () => {
    const h = renderStatArbBlotter(rows, true).value;
    expect(h).toContain('ETH/BTC');
    expect(h).toContain('1.84 → 0.21');
    expect(h).toContain('+$125.00');
    expect(h).toContain('2026-06-06 11:30:00');
  });

  it('shows the empty-but-available state', () => {
    expect(renderStatArbBlotter([], true).value).toContain('no closed trades yet');
  });

  it('shows the needs-Postgres note when persistence is off', () => {
    const h = renderStatArbBlotter([], false).value;
    expect(h).toContain('persists with Postgres');
  });
});

describe('renderStatArbLaunchForm', () => {
  it('builds the pair launch form with the strategy catalogue', () => {
    const h = renderStatArbLaunchForm([{ id: 'pairs-zscore', label: 'Pairs — rolling z-score' }]).value;
    expect(h).toContain('endpoint="/api/stat-arb/live/portfolio/launch"');
    expect(h).toContain('name="symbolA"');
    expect(h).toContain('name="symbolB"');
    expect(h).toContain('name="beta"');
    expect(h).toContain('<option value="pairs-zscore">Pairs — rolling z-score</option>');
    expect(h).toContain('replaces'); // reconfigure hint
  });
});

describe('renderStatArbPage', () => {
  it('wraps controls + launch form + live region + blotter in the shared shell', () => {
    const state: StatArbDeskState = { snap: snap(), events: [], blotter: [], blotterAvailable: false, strategies: [] };
    const html = renderStatArbPage(state);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('endpoint="/api/stat-arb/live/portfolio/start"'); // stat-arb controls
    expect(html).toContain('class="panel launch"');
    expect(html).toContain('<desk-feed src="/desk/statarb/stream" target="statarb-live">');
    expect(html).toContain('id="statarb-live"');
    expect(html).toContain('persists with Postgres'); // blotter note (unavailable)
    expect(html).toContain('nav-link--active');
  });
});
