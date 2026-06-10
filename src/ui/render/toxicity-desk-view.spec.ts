import { renderToxicityLive, renderToxicityPage } from './toxicity-desk-view';
import { MmPortfolioSnapshot } from '../../market-making/live/mm-portfolio-trader';
import { MmBookSnapshot } from '../../market-making/live/mm-book';

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
    lastBarAt: null,
    midMicros: '63000000000',
    bidMicros: '62990000000',
    askMicros: '63010000000',
    reservationMicros: '63000500000',
    halfSpreadMicros: '10000000',
    inventoryUnits: '250000',
    capitalUnits: '100000000000',
    equityUnits: '100700000000',
    realisedPnlUnits: '400000000',
    unrealisedPnlUnits: '300000000',
    feesUnits: '2000000',
    fundingUnits: '1500000',
    fundingRatePerHour: 0,
    netPnlUnits: '699500000',
    spreadCapturedUnits: '900000000',
    adverseSelectionUnits: '200500000',
    inventoryCarryUnits: '0',
    inventoryNotionalCapUnits: '0',
    vpin: 0.68,
    vpinBuckets: 80,
    vpinWindowBuckets: 50,
    bookImbalance: 0.31,
    tradeFlowImbalance: -0.55,
    markout: [],
    markoutBySide: { buy: [], sell: [] },
    toxicity: { widenSteps: 12, tightenSteps: 340, avgScale: 0.71, maxScale: 2.43, lastScale: 1.24 },
    fills: 72,
    bidFills: 36,
    askFills: 36,
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

describe('renderToxicityLive', () => {
  it('renders a warmed VPIN gauge with its value and bucket count', () => {
    const h = renderToxicityLive(snap()).value;
    expect(h).toContain('BTC·hyperliquid');
    expect(h).toContain('0.68');
    expect(h).toContain('(80 buckets)');
  });

  it('greys the VPIN gauge until bucketsSeen clears the EMA window (the honesty rule)', () => {
    const h = renderToxicityLive(snap({ books: [book({ vpinBuckets: 12 })] })).value;
    expect(h).toContain('warming 12/50 buckets');
    expect(h).not.toContain('(12 buckets)'); // no value pretending to be a reading
  });

  it('renders signed imbalance bars as neutral direction (never pos/neg money colours)', () => {
    const h = renderToxicityLive(snap()).value;
    expect(h).toContain('book imb');
    expect(h).toContain('+0.31');
    expect(h).toContain('flow imb');
    expect(h).toContain('−0.55');
    expect(h).not.toContain('imb-fill pos'); // direction is not good/bad
  });

  it('says n/a honestly for a bar-path book with no imbalance reads', () => {
    const h = renderToxicityLive(snap({ books: [book({ bookImbalance: undefined, tradeFlowImbalance: undefined })] })).value;
    expect(h).toContain('n/a (bar path)');
  });

  it('renders the F3 scale row, the verdict chip, and the not-yet-validated footnote', () => {
    const h = renderToxicityLive(snap()).value;
    expect(h).toContain('×1.24');
    expect(h).toContain('widen 12 / tighten 340');
    expect(h).toContain('badge--allow');
    expect(h).toContain('monitoring, not yet validated as predictive');
    const off = renderToxicityLive(snap({ books: [book({ toxicity: undefined })] })).value;
    expect(off).toContain('F3 scale');
    expect(off).toContain('>off<');
  });

  it('shows an honest empty state with no books', () => {
    expect(renderToxicityLive(snap({ books: [] })).value).toContain('no books launched');
  });
});

describe('renderToxicityPage', () => {
  it('wraps the live region in the shared shell with its SSE feed', () => {
    const h = renderToxicityPage(snap());
    expect(h.startsWith('<!doctype html>')).toBe(true);
    expect(h).toContain('<desk-feed src="/desk/toxicity/stream" target="tox-live">');
    expect(h).toContain('id="tox-live"');
  });

  it('places the self-polling <tox-strips> history OUTSIDE the SSE region (a tick must not wipe the buffer)', () => {
    const h = renderToxicityPage(snap());
    expect(h).toContain('<tox-strips src="/api/market-making/snapshot" minutes="15">');
    expect(h.indexOf('id="tox-live"')).toBeLessThan(h.indexOf('<tox-strips'));
  });
});
