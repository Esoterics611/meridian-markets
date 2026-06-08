import { renderMmDeskLive, renderLaunchForm, renderMmDeskPage, MmDeskState } from './mm-desk-view';
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';
import { DeskEvent } from '../../market-making/events/desk-event';

function book(over: Partial<MmBookSnapshot> = {}): MmBookSnapshot {
  return {
    symbol: 'BTC',
    strategyId: 'mm-glft',
    source: 'hyperliquid',
    family: 'glft',
    running: true,
    warm: true,
    barsSeen: 120,
    seededBars: 60,
    lastBarAt: '2026-06-06T12:00:00.000Z',
    midMicros: '63000000000', // 63,000.00
    bidMicros: '62990000000',
    askMicros: '63010000000',
    reservationMicros: '63000500000',
    halfSpreadMicros: '10000000', // 10.00
    inventoryUnits: '250000', // 0.25
    capitalUnits: '100000000000',
    equityUnits: '100700000000',
    realisedPnlUnits: '400000000', // +$400.00
    unrealisedPnlUnits: '300000000', // +$300.00 (inv MTM)
    feesUnits: '2000000', // $2.00 cost (engine convention: + cost, − rebate)
    fundingUnits: '1500000', // +$1.50
    fundingRatePerHour: 0,
    // net = realised − fees + invMTM + funding = 400 − 2 + 300 + 1.5 = 699.50 (the cash grid sums to this)
    netPnlUnits: '699500000', // +$699.50
    spreadCapturedUnits: '900000000', // +$900.00
    adverseSelectionUnits: '-200500000', // −$200.50
    inventoryCarryUnits: '0', inventoryNotionalCapUnits: '0',
    fills: 42,
    bidFills: 21,
    askFills: 21,
    blockedQuotes: 3,
    lastVerdict: 'Allow',
    maxDrawdownPct: 0.53,
    ...over,
  };
}

function snap(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: true,
    bookCount: 1,
    capitalUnits: '100000000000',
    equityUnits: '100699500000',
    realisedPnlUnits: '400000000',
    unrealisedPnlUnits: '300000000',
    feesUnits: '2000000',
    fundingUnits: '1500000',
    netPnlUnits: '699500000',
    books: [book()],
    ...over,
  };
}

function ev(over: Partial<DeskEvent> = {}): DeskEvent {
  return {
    seq: 1,
    ts: Date.parse('2026-06-06T12:00:05.000Z'),
    desk: 'mm',
    kind: 'fill',
    book: 'BTC',
    source: 'hyperliquid',
    message: 'BTC ▸ BUY 0.25 @ 62,990.00 — opened long (fee +$0.01)',
    ...over,
  };
}

describe('renderMmDeskLive', () => {
  it('renders the desk summary from the snapshot', () => {
    const h = renderMmDeskLive(snap()).value;
    expect(h).toContain('desk nav');
    expect(h).toContain('$100,699.50');
    expect(h).toContain('+$699.50');
    expect(h).toContain('>RUNNING<');
  });

  it('renders a per-book card: quotes, cash P&L (sums to net), mark-out diagnostic and verdict', () => {
    const h = renderMmDeskLive(snap()).value;
    expect(h).toContain('BTC·hyperliquid');
    expect(h).toContain('62,990.00'); // bid
    expect(h).toContain('63,010.00'); // ask
    // cash grid — these four lines sum to net P&L
    expect(h).toContain('+$400.00'); // realised
    expect(h).toContain('+$300.00'); // inv MTM (unrealised)
    expect(h).toContain('−$2.00'); // fees (contribution sign: a $2 cost reduces net)
    expect(h).toContain('+$1.50'); // funding
    expect(h).toContain('+$699.50'); // net P&L = 400 − 2 + 300 + 1.5
    // mark-out attribution — a diagnostic, explicitly NOT part of net
    expect(h).toContain('+$900.00'); // spread captured
    expect(h).toContain('−$200.50'); // adverse selection
    expect(h).toContain('diagnostic · ≠ net');
    expect(h).toContain('badge--allow'); // verdict
    expect(h).toContain('fills 42 (b21/a21)');
  });

  it('wires the per-book remove button to the symbol it sits on', () => {
    const h = renderMmDeskLive(snap()).value;
    expect(h).toContain('endpoint="/api/market-making/remove"');
    expect(h).toContain('&quot;symbol&quot;:&quot;BTC&quot;'); // JSON body, html-escaped
    expect(h).toContain('Remove + flatten BTC?'); // confirm names the book
  });

  it('shows a WARMING badge for a book that is not warm yet', () => {
    const h = renderMmDeskLive(snap({ books: [book({ warm: false })] })).value;
    expect(h).toContain('WARMING');
  });

  it('renders "—" for a book with no quote yet', () => {
    const h = renderMmDeskLive(snap({ books: [book({ bidMicros: null, askMicros: null })] })).value;
    expect(h).toContain('—');
  });

  it('shows an honest empty state for no books (the tape is now the static append-mode component)', () => {
    const h = renderMmDeskLive(snap({ bookCount: 0, books: [] })).value;
    expect(h).toContain('no books launched');
    // the Activity tape is no longer in the SSE region — it must not be here
    expect(h).not.toContain('activity-tape');
    expect(h).not.toContain('class="panel activity"');
  });
});

describe('renderLaunchForm', () => {
  it('builds the launch + preset forms with the catalogue options', () => {
    const h = renderLaunchForm(
      [{ id: 'mm-glft', label: 'GLFT' }],
      [{ id: 'hl-perps', label: 'Hyperliquid Perps' }],
    ).value;
    expect(h).toContain('endpoint="/api/market-making/launch"');
    expect(h).toContain('endpoint="/api/market-making/launch-preset"');
    expect(h).toContain('<option value="mm-glft">GLFT</option>');
    expect(h).toContain('<option value="hl-perps">Hyperliquid Perps</option>');
    expect(h).toContain('name="symbol"');
    expect(h).toContain('name="quoteNotionalUsd"');
    expect(h).toContain('replaces'); // the reconfigure hint
  });
});

describe('renderMmDeskPage', () => {
  it('wraps controls + launch form + live region in the shared shell', () => {
    const state: MmDeskState = { snap: snap(), events: [], cursor: 0, strategies: [], presets: [] };
    const html = renderMmDeskPage(state);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('class="action-palette"'); // shared desk controls
    expect(html).toContain('class="panel launch"'); // launch form
    expect(html).toContain('<desk-feed src="/desk/mm/stream" target="mm-live">');
    expect(html).toContain('id="mm-live"');
    expect(html).toContain('src="/ui/desk-form.js"');
    expect(html).toContain('nav-link--active');
  });

  it('renders the desk equity sparkline OUTSIDE the SSE live region', () => {
    const state: MmDeskState = { snap: snap(), events: [], cursor: 0, strategies: [], presets: [] };
    const html = renderMmDeskPage(state);
    expect(html).toContain('<nav-spark book="" hours="24"');
    // it must sit before the live region so an SSE tick can't recreate it mid-fetch
    expect(html.indexOf('<nav-spark')).toBeLessThan(html.indexOf('id="mm-live"'));
  });

  it('renders the append-mode <activity-tape> OUTSIDE the SSE region: rows newest-first + cursor + endpoint', () => {
    const events = [
      ev({ seq: 7, kind: 'launch', message: 'BTC ▸ launched' }),
      ev({ seq: 8, kind: 'fill', message: 'BTC ▸ BUY 0.25 @ 62,990.00 — opened long' }),
    ];
    const state: MmDeskState = { snap: snap(), events, cursor: 8, strategies: [], presets: [] };
    const html = renderMmDeskPage(state);
    // the dedicated component, pointed at the MM events endpoint with the lastSeq cursor
    expect(html).toContain('<activity-tape src="/api/market-making/events" cursor="8"');
    // initial paint: newest (seq 8) before oldest (seq 7), engine message verbatim
    expect(html.indexOf('opened long')).toBeLessThan(html.indexOf('launched'));
    // and it lives AFTER the live region (self-polls; must not be inside the SSE swap)
    expect(html.indexOf('id="mm-live"')).toBeLessThan(html.indexOf('<activity-tape'));
  });
});
