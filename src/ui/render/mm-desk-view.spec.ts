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
    inventoryCarryUnits: '0', inventoryNotionalCapUnits: '0', vpin: 0, vpinBuckets: 0, vpinWindowBuckets: 50, markout: [], markoutBySide: { buy: [], sell: [] },
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

  it('renders the delta-hedge panel (DR-2) only when the hedge is enabled, with gross/residual/P&L', () => {
    const hedge = {
      enabled: true,
      grossDeltaUsd: 12000,
      residualUsd: 600,
      hedgePnlUsd: 41.5,
      hedgeCostUsd: 12,
      fundingUsd: 8,
      perUnderlying: [{ underlying: 'BTC', netDeltaUsd: -12000, hedgeUnits: 0.19, hedgeNotionalUsd: 11400, residualUsd: -600 }],
      ordersLastTick: [],
    };
    const h = renderMmDeskLive(snap({ hedge, hedgePnlUnits: '41500000' })).value;
    expect(h).toContain('delta hedge');
    expect(h).toContain('gross Δ');
    expect(h).toContain('$12,000.00'); // gross delta
    expect(h).toContain('neutralised'); // residual / gross
    expect(h).toContain('+$41.50'); // hedge P&L folded into desk net
    // off ⇒ no panel
    expect(renderMmDeskLive(snap()).value).not.toContain('delta hedge');
    // no quality block yet (tracker still priming) ⇒ no basis stat, no per-book quality row
    expect(h).not.toContain('basis σ');
  });

  it('renders the §0 hedge-quality read (basis σ + per-book β/R²) when the tracker has samples', () => {
    const hedge = {
      enabled: true,
      grossDeltaUsd: 12000,
      residualUsd: 600,
      hedgePnlUsd: 41.5,
      hedgeCostUsd: 12,
      fundingUsd: 8,
      perUnderlying: [{ underlying: 'BTC', netDeltaUsd: -12000, hedgeUnits: 0.19, hedgeNotionalUsd: 11400, residualUsd: -600 }],
      ordersLastTick: [],
      quality: {
        samples: 120,
        bucketMs: 60_000,
        deskPnlVolUsdPerHour: 1000,
        deskFactorVolUsdPerHour: 800,
        deskBasisVolUsdPerHour: 600,
        perBook: [
          {
            symbol: 'SOL',
            underlying: 'BTC',
            betaCfg: 1.1,
            betaLive: 1.03,
            r2: 0.72,
            pnlVolUsdPerHour: 500,
            factorVolUsdPerHour: 420,
            basisVolUsdPerHour: 270,
            basisShare: 0.29,
            samples: 120,
          },
        ],
      },
    };
    const h = renderMmDeskLive(snap({ hedge, hedgePnlUnits: '41500000' })).value;
    expect(h).toContain('basis σ'); // the vol the delta hedge cannot touch, next to "neutralised"
    expect(h).toContain('$600.00'); // desk basis vol per √hour
    expect(h).toContain('36.00% unhedgeable'); // (600/1000)² of desk variance
    expect(h).toContain('· 60s buckets'); // the σ names its horizon (TRADER_UI_SPEC §4)
    expect(h).toContain('SOL→BTC β1.10→1.03 R²0.72 basis 29%'); // the WP6 ranking row
  });

  it('links the book-card header to /desk/markout (deep-dive is one click — TRADER_UI_SPEC §4)', () => {
    const h = renderMmDeskLive(snap()).value;
    expect(h).toContain('class="mono book-sym book-sym--link" href="/desk/markout"');
  });

  it('renders the 60s per-side markout cells next to the P&L, with the markout-page honesty rules', () => {
    // default fixture: no 60s horizon resolved → both cells "—"
    const blank = renderMmDeskLive(snap()).value;
    expect(blank).toContain('mo60 b');
    expect(blank).toContain('mo60 a');
    expect(blank).toMatch(/mo60 b<\/span><span class="av mono dim"[^>]*>—/);
    // with resolved 60s curves: signed bps + fill count, coloured by sign at ≥30 fills
    const withMo = renderMmDeskLive(
      snap({
        books: [
          book({
            markoutBySide: {
              buy: [{ ms: 60_000, bps: -3.42, count: 40 }],
              sell: [{ ms: 60_000, bps: 1.05, count: 12 }],
            },
          }),
        ],
      }),
    ).value;
    expect(withMo).toContain('−3.4bp·40f'); // buy side, sampled → red (picked off)
    expect(withMo).toMatch(/mo60 b[\s\S]{0,120}av mono neg/);
    expect(withMo).toContain('+1.1bp·12f'); // sell side, 12 fills < 30 → dim (noise)
    expect(withMo).toMatch(/mo60 a[\s\S]{0,120}av mono dim/);
  });

  it('renders the F3 toxicity diagnostics on a book card when the scaler is wired (DR-3)', () => {
    const h = renderMmDeskLive(snap({ books: [book({ toxicity: { widenSteps: 12, tightenSteps: 340, avgScale: 0.71, maxScale: 2.43, lastScale: 0.6 } })] })).value;
    expect(h).toContain('F3 widen 12/tighten 340');
    expect(h).toContain('scale 0.60 (max 2.43)');
    // a book with no scaler shows no F3 line
    expect(renderMmDeskLive(snap()).value).not.toContain('F3 widen');
  });

  it('reddens maxDD only when it breaches the drawdown budget (always-bad → red over budget, dim within)', () => {
    const under = renderMmDeskLive(snap()).value; // 0.53% — inside the 2% budget
    expect(under).toContain('maxDD <span class="dim">0.53%</span>');
    const over = renderMmDeskLive(snap({ books: [book({ maxDrawdownPct: 3.2 })] })).value;
    expect(over).toContain('maxDD <span class="neg">3.20%</span>');
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
