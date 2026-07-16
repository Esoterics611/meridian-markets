import { fmtPx, renderMarketsPage, renderMarketsStrip, MarketsPageState, StripData } from './markets-view';

// Pure render → assert HTML (UI_ARCHITECTURE §10). The honest states matter most:
// FEED DOWN strips, the no-L2 venue note, and the not-served-yet footer (E6/E7).

function strip(over: Partial<StripData> = {}): StripData {
  return {
    symbol: 'BTC',
    venue: 'hyperliquid',
    last: 118_250.5,
    deltaPct: 1.23,
    hi: 119_000,
    lo: 116_500,
    spreadBps: 0.85,
    asOfMs: 1_783_100_000_000,
    ...over,
  };
}

function state(over: Partial<MarketsPageState> = {}): MarketsPageState {
  return {
    symbol: 'BTC',
    venue: 'hyperliquid',
    hours: 24,
    symbols: ['BTC', 'ETH', 'SOL'],
    venues: ['hyperliquid', 'binance'],
    hasL2: true,
    strip: strip(),
    events: [],
    cursor: 0,
    ...over,
  };
}

describe('fmtPx', () => {
  it('scales precision to the price (no fake precision, no unreadable ints)', () => {
    expect(fmtPx(118250.5)).toBe('118,250.50');
    expect(fmtPx(0.4321567)).toBe('0.4322');
    expect(fmtPx(0.00123456)).toBe('0.001235');
    expect(fmtPx(null)).toBe('—');
  });
});

describe('renderMarketsStrip', () => {
  it('shows last price, 24h Δ (signed + colored), range, and the live spread', () => {
    const h = renderMarketsStrip(strip()).value;
    expect(h).toContain('118,250.50');
    expect(h).toContain('+1.23%');
    expect(h).toContain('pos');
    expect(h).toContain('116,500.00 — 119,000.00');
    expect(h).toContain('0.85 bps');
    expect(h).toContain('PAPER');
  });

  it('colors a down day red and renders — for a spread without an L2 venue', () => {
    const h = renderMarketsStrip(strip({ deltaPct: -2.5, spreadBps: null })).value;
    expect(h).toContain('−2.50%');
    expect(h).toContain('neg');
    expect(h).toContain('spread needs an L2 venue');
  });

  it('renders the honest FEED DOWN state with the reason (never stale numbers)', () => {
    const h = renderMarketsStrip(strip({ error: 'feed unreachable (timeout)' })).value;
    expect(h).toContain('FEED DOWN');
    expect(h).toContain('feed unreachable (timeout)');
    expect(h).not.toContain('118,250');
  });
});

describe('renderMarketsPage', () => {
  it('is a full document: picker form, SSE strip region, chart, ladder, and the symbol tape', () => {
    const h = renderMarketsPage(state());
    expect(h.startsWith('<!doctype html>')).toBe(true);
    // GET picker (server-rendered navigation, no JS state)
    expect(h).toContain('method="get" action="/markets"');
    expect(h).toContain('<option value="BTC" selected>');
    expect(h).toContain('<option value="hyperliquid" selected>');
    // the live strip is the SSE region
    expect(h).toContain('<desk-feed src="/markets/stream?symbol=BTC&venue=hyperliquid" target="markets-strip">');
    // chart + ladder wired to the right endpoints
    expect(h).toContain('<mkt-chart src="/markets/chart?symbol=BTC&venue=hyperliquid&hours=24" refresh="20">');
    expect(h).toContain('<depth-ladder src="/api/market-data/l2/stream?symbol=BTC&venue=hyperliquid">');
    // our per-symbol tape, book-filtered
    expect(h).toContain('book="BTC"');
  });

  it('renders the honest no-L2 note instead of a ladder for a depthless venue', () => {
    const h = renderMarketsPage(state({ venue: 'binance', hasL2: false }));
    expect(h).not.toContain('<depth-ladder');
    expect(h).toContain('no depth feed for binance');
  });

  it('says plainly what is NOT served yet (venue prints E7, quote history E6)', () => {
    const h = renderMarketsPage(state());
    expect(h).toMatch(/not\s+served yet/);
    expect(h).toContain('OUR paper desk');
  });
});
