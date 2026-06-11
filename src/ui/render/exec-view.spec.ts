import { renderExecLive, renderExecPage } from './exec-view';
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';

// The exec page is a pure projection of MmPortfolioSnapshot — so we test it the
// way the redesign promises (UI_ARCHITECTURE.md §testability): build a snapshot,
// render the fragment, assert the HTML. No DOM, no server, no DB.

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
    midMicros: '63000000000',
    bidMicros: '62990000000',
    askMicros: '63010000000',
    reservationMicros: '63000000000',
    halfSpreadMicros: '10000000',
    inventoryUnits: '250000', // 0.25
    capitalUnits: '100000000000', // $100,000
    equityUnits: '100500000000',
    realisedPnlUnits: '400000000',
    unrealisedPnlUnits: '100000000',
    feesUnits: '-2000000',
    fundingUnits: '0',
    fundingRatePerHour: 0,
    netPnlUnits: '500000000', // +$500.00
    spreadCapturedUnits: '700000000',
    adverseSelectionUnits: '-200000000',
    inventoryCarryUnits: '0', inventoryMtmUnits: '0', inventoryNotionalCapUnits: '0', vpin: 0, vpinBuckets: 0, vpinWindowBuckets: 50, markout: [], markoutBySide: { buy: [], sell: [] },
    fills: 42,
    bidFills: 21,
    askFills: 21,
    blockedQuotes: 3,
    lastVerdict: 'Allow',
    maxDrawdownPct: 0.53,
    ...over,
  };
}

function snapshot(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: true,
    bookCount: 1,
    capitalUnits: '100000000000', // $100,000
    equityUnits: '101234000000', // $101,234.00
    realisedPnlUnits: '900000000',
    unrealisedPnlUnits: '334000000',
    feesUnits: '-4000000',
    fundingUnits: '0',
    netPnlUnits: '1234000000', // +$1,234.00 → +1.23% on $100k
    books: [book()],
    ...over,
  };
}

describe('renderExecLive', () => {
  it('renders the desk headline stats from the snapshot', () => {
    const h = renderExecLive(snapshot()).value;
    expect(h).toContain('desk nav');
    expect(h).toContain('$101,234.00'); // equity → usd()
    expect(h).toContain('+$1,234.00'); // net p&l → money()
    expect(h).toContain('+1.23%'); // return on capital
    expect(h).toContain('RUNNING');
    expect(h).toContain('badge--paper'); // honest: always paper
  });

  it('renders a per-book row with money, drawdown, inventory and verdict', () => {
    const h = renderExecLive(snapshot()).value;
    expect(h).toContain('BTC·hyperliquid'); // symbol·source label
    expect(h).toContain('+$500.00'); // book net p&l
    expect(h).toContain('0.53%'); // book max drawdown
    expect(h).toContain('0.25'); // inventory qty (fmtQty of 250000)
    expect(h).toContain('badge--allow');
    expect(h).toContain('>Allow</span>');
  });

  it('flags a drawdown that breaches the 2% budget as negative', () => {
    const h = renderExecLive(snapshot({ books: [book({ maxDrawdownPct: 3.5 })] })).value;
    expect(h).toContain('3.50%');
    // the headline drawdown cell and the book cell both carry the neg class
    expect(h).toMatch(/stat-v mono neg/);
  });

  it('shows PAUSED when the desk loop is stopped', () => {
    const h = renderExecLive(snapshot({ running: false })).value;
    expect(h).toContain('PAUSED');
    expect(h).not.toContain('>RUNNING<');
  });

  it('renders an honest empty state when no books are launched', () => {
    const h = renderExecLive(snapshot({ bookCount: 0, books: [] })).value;
    expect(h).toContain('no books launched');
  });

  it('escapes nothing dangerous but keeps the snapshot numbers verbatim', () => {
    // negative net p&l renders with the minus glyph + neg class (not a raw '-')
    const h = renderExecLive(snapshot({ netPnlUnits: '-50000000' })).value;
    expect(h).toContain('−$50.00');
  });
});

describe('renderExecPage', () => {
  it('wraps the live region in the shared shell + desk-feed component', () => {
    const html = renderExecPage(snapshot());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<link rel="stylesheet" href="/ui/ui.css" />');
    expect(html).toContain('src="/ui/desk-feed.js"');
    // the shared live-update component, pointed at the exec SSE stream + region
    expect(html).toContain('<desk-feed src="/exec/stream" target="exec-live">');
    expect(html).toContain('id="exec-live"');
    // the active role is highlighted in the shared top bar
    expect(html).toContain('nav-link--active');
  });

  it('renders the desk-aggregate equity sparkline OUTSIDE the SSE live region', () => {
    const html = renderExecPage(snapshot());
    // desk aggregate = empty book key; placed after the live region so an SSE tick
    // never recreates it (it self-fetches /api/market-making/nav on its own timer).
    expect(html).toContain('<nav-spark book="" hours="24"');
    expect(html.indexOf('id="exec-live"')).toBeLessThan(html.indexOf('<nav-spark'));
  });
});
