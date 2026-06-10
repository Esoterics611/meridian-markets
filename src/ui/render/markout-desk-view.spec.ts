import { renderMarkoutLive, renderMarkoutPage, deskAverageMarkout, MIN_SAMPLES } from './markout-desk-view';
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
    vpin: 0.4,
    vpinBuckets: 80,
    vpinWindowBuckets: 50,
    markout: [
      { ms: 1000, bps: -2.5, count: 72 },
      { ms: 30000, bps: 1.7, count: 72 },
    ],
    markoutBySide: {
      buy: [
        { ms: 1000, bps: -2.4, count: 36 },
        { ms: 30000, bps: 2.1, count: 36 },
      ],
      sell: [
        { ms: 1000, bps: -2.6, count: 36 },
        { ms: 30000, bps: 1.3, count: 36 },
      ],
    },
    toxicity: { widenSteps: 12, tightenSteps: 340, avgScale: 0.71, maxScale: 2.43, lastScale: 0.6 },
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

describe('deskAverageMarkout', () => {
  it('fill-count-weights the per-book curves per horizon', () => {
    const books = [
      book({ markout: [{ ms: 1000, bps: -2, count: 100 }] }),
      book({ symbol: 'ETH', markout: [{ ms: 1000, bps: 2, count: 300 }] }),
    ];
    const avg = deskAverageMarkout(books);
    expect(avg).toEqual([{ ms: 1000, bps: 1, count: 400 }]); // (−2·100 + 2·300)/400
  });

  it('skips zero-count horizons (no fills = no information, not a 0bps read)', () => {
    expect(deskAverageMarkout([book({ markout: [{ ms: 1000, bps: 0, count: 0 }] })])).toEqual([]);
  });
});

describe('renderMarkoutLive', () => {
  it('renders the desk strip: total fills + weighted average per horizon with sample counts', () => {
    const h = renderMarkoutLive(snap()).value;
    expect(h).toContain('desk fills');
    expect(h).toContain('avg markout @ 1s');
    expect(h).toContain('avg markout @ 30s');
    expect(h).toContain('−2.50bps');
    expect(h).toContain('72 fills'); // every number names its sample count
  });

  it('renders three rows per book (all / buy / sell) with per-side fill counts', () => {
    const h = renderMarkoutLive(snap()).value;
    expect(h).toContain('BTC·hyperliquid');
    expect(h).toContain('>all <span class="mono">72</span>');
    expect(h).toContain('>buy <span class="mono">36</span>');
    expect(h).toContain('>sell <span class="mono">36</span>');
  });

  it('colours by sign — green markout = the move went our way, red = picked off', () => {
    const h = renderMarkoutLive(snap()).value;
    expect(h).toContain('mono neg">−2.50'); // 1s, adverse
    expect(h).toContain('mono pos">+1.70'); // 30s, recovered
  });

  it(`dims a cell under ${MIN_SAMPLES} samples instead of pretending significance`, () => {
    const thin = book({ markout: [{ ms: 1000, bps: -9, count: 5 }], markoutBySide: { buy: [], sell: [] } });
    const h = renderMarkoutLive(snap({ books: [thin] })).value;
    expect(h).toContain('mono dim">−9.00'); // not red — under-sampled
  });

  it('flags one-sided informed flow (amber) when |buy − sell| at the longest sampled horizon > 2bps', () => {
    const skewed = book({
      markoutBySide: {
        buy: [{ ms: 30000, bps: -5, count: 40 }],
        sell: [{ ms: 30000, bps: 0.5, count: 40 }],
      },
      markout: [{ ms: 30000, bps: -2.2, count: 80 }],
    });
    const h = renderMarkoutLive(snap({ books: [skewed] })).value;
    expect(h).toContain('ONE-SIDED 5.5bps @ 30s');
    // the symmetric default book carries no flag
    expect(renderMarkoutLive(snap()).value).not.toContain('ONE-SIDED');
  });

  it('does not flag asymmetry off thin sides (< 30 fills/side is noise)', () => {
    const thin = book({
      markoutBySide: {
        buy: [{ ms: 30000, bps: -9, count: 5 }],
        sell: [{ ms: 30000, bps: 3, count: 5 }],
      },
    });
    expect(renderMarkoutLive(snap({ books: [thin] })).value).not.toContain('ONE-SIDED');
  });

  it('shows the F3 reaction on the same card (cause → effect → outcome on one screen)', () => {
    const h = renderMarkoutLive(snap()).value;
    expect(h).toContain('F3 widen 12/tighten 340');
    const off = renderMarkoutLive(snap({ books: [book({ toxicity: undefined })] })).value;
    expect(off).toContain('F3 off — half-spread unscaled');
  });

  it('renders the honest-numbers note and an empty state', () => {
    expect(renderMarkoutLive(snap()).value).toContain('are noise — wait');
    expect(renderMarkoutLive(snap({ books: [] })).value).toContain('no books launched');
  });
});

describe('renderMarkoutPage', () => {
  it('wraps the live region in the shared shell with its SSE feed', () => {
    const h = renderMarkoutPage(snap());
    expect(h.startsWith('<!doctype html>')).toBe(true);
    expect(h).toContain('<desk-feed src="/desk/markout/stream" target="markout-live">');
    expect(h).toContain('id="markout-live"');
    expect(h).toContain('nav-link--active'); // /desk/markout is in the role nav
  });
});
