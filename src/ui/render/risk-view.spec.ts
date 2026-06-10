import { renderRiskLive, renderRiskActions, renderRiskPage, RiskState } from './risk-view';
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
    reservationMicros: '63000000000',
    halfSpreadMicros: '10000000',
    inventoryUnits: '250000', // 0.25 → exposure 0.25 × 63,000 = $15,750
    capitalUnits: '100000000000',
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    feesUnits: '0',
    fundingUnits: '0',
    fundingRatePerHour: 0,
    netPnlUnits: '0',
    spreadCapturedUnits: '0',
    adverseSelectionUnits: '-200500000', // −$200.50 toxicity
    inventoryCarryUnits: '0', inventoryNotionalCapUnits: '0', vpin: 0, vpinBuckets: 0, vpinWindowBuckets: 50, markout: [], markoutBySide: { buy: [], sell: [] },
    fills: 42,
    bidFills: 21,
    askFills: 21,
    blockedQuotes: 0,
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
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    feesUnits: '0',
    fundingUnits: '0',
    netPnlUnits: '0',
    books: [book()],
    ...over,
  };
}

function verdict(over: Partial<DeskEvent> = {}): DeskEvent {
  return {
    seq: 1,
    ts: Date.parse('2026-06-06T12:00:05.000Z'),
    desk: 'mm',
    kind: 'verdict',
    book: 'BTC',
    source: 'hyperliquid',
    message: 'BTC ▸ risk Allow → Pause (quoting blocked)',
    verdict: 'Pause',
    prevVerdict: 'Allow',
    ...over,
  };
}

describe('renderRiskLive', () => {
  it('renders the drawdown / exposure headline', () => {
    const h = renderRiskLive(snap(), []).value;
    expect(h).toContain('max book drawdown');
    expect(h).toContain('0.53%');
    expect(h).toContain('2.00% budget');
    expect(h).toContain('+$15,750.00'); // net exposure = 0.25 × 63,000
    // exposure is a DIRECTION, not good/bad → neutral cell, never signClass (no pos/neg)
    expect(h).toContain('<td class="num mono">+$15,750.00</td>');
  });

  it('flags drawdown breaches + blocked books, and colours by meaning (dd over budget = red, blocked = amber)', () => {
    const h = renderRiskLive(
      snap({ books: [book({ maxDrawdownPct: 3.5, lastVerdict: 'Deny', blockedQuotes: 7 })] }),
      [],
    ).value;
    expect(h).toContain('3.50%');
    expect(h).toContain('badge--deny');
    // drawdown OVER budget is a real breach → red
    expect(h).toMatch(/books over budget[\s\S]*?stat-v mono neg/);
    // blocked = the gate intervening (not a loss) → amber, per-book cell AND the desk stat
    expect(h).toContain('<td class="num warn">7</td>');
    expect(h).toMatch(/blocked books[\s\S]*?stat-v mono warn/);
  });

  it('shows adverse selection as the realised toxicity cost and points to the live gauges', () => {
    const h = renderRiskLive(snap(), []).value;
    expect(h).toContain('−$200.50'); // adverse selection
    expect(h).toContain('adverse'); // labelled as the toxicity signal
    expect(h).toContain('href="/desk/toxicity"'); // the live VPIN gauges live there now (WP2a)
  });

  it('renders cap use per book: "no cap" when the rail is unset, % + bar when set, amber from 80%', () => {
    // default fixture: inventoryNotionalCapUnits '0' → no rail
    expect(renderRiskLive(snap(), []).value).toContain('no cap');
    // exposure $15,750 vs $50,000 cap = 32% → dim
    const under = renderRiskLive(snap({ books: [book({ inventoryNotionalCapUnits: '50000000000' })] }), []).value;
    expect(under).toContain('32%');
    expect(under).toContain('cap-bar-fill dim');
    // exposure $15,750 vs $17,500 cap = 90% → amber (nearing the rail)
    const near = renderRiskLive(snap({ books: [book({ inventoryNotionalCapUnits: '17500000000' })] }), []).value;
    expect(near).toContain('90%');
    expect(near).toContain('cap-bar-fill warn');
  });

  it('renders an honest exposure block when the hedge is OFF', () => {
    const h = renderRiskLive(snap(), []).value;
    expect(h).toContain('exposure &amp; hedge');
    expect(h).toContain('delta hedge OFF');
  });

  it('renders the hedge legs + the factor-vs-basis σ split when the hedge is ON (TRADER_UI_SPEC §4)', () => {
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
        perBook: [],
      },
    };
    const h = renderRiskLive(snap({ hedge }), []).value;
    expect(h).toContain('BTC Δ−$12,000.00 → hedged $11,400.00 → resid −$600.00');
    expect(h).toContain('36.00% of variance the delta hedge cannot touch'); // (600/1000)²
    expect(h).toContain('60s buckets, n=120'); // horizon + sample count on the glass
    expect(h).not.toContain('delta hedge OFF');
  });

  it('wires the per-book risk action to remove (the available per-book lever)', () => {
    const h = renderRiskLive(snap(), []).value;
    expect(h).toContain('endpoint="/api/market-making/remove"');
    expect(h).toContain('&quot;symbol&quot;:&quot;BTC&quot;');
    expect(h).toContain('flatten + drop');
  });

  it('renders the verdict-transition feed with the engine message verbatim', () => {
    const h = renderRiskLive(snap(), [verdict()]).value;
    expect(h).toContain('risk-verdict transitions');
    expect(h).toContain('Allow → Pause');
  });

  it('honest empty states (no books / no verdicts)', () => {
    const h = renderRiskLive(snap({ bookCount: 0, books: [] }), []).value;
    expect(h).toContain('nothing at risk');
    expect(h).toContain('no verdict changes yet');
  });
});

describe('renderRiskActions', () => {
  it('offers only the real de-risk levers (stop/flatten both desks)', () => {
    const h = renderRiskActions().value;
    expect(h).toContain('endpoint="/api/market-making/stop"');
    expect(h).toContain('endpoint="/api/market-making/flatten"');
    expect(h).toContain('endpoint="/api/stat-arb/live/portfolio/flatten"'); // cross-desk kill
  });

  it('is honest that pause/deny + limits have no endpoint yet', () => {
    const h = renderRiskActions().value;
    expect(h).toMatch(/pause\/deny/i);
    expect(h).toMatch(/not built yet|no .*endpoint/i);
  });
});

describe('renderRiskPage', () => {
  it('wraps the de-risk palette + live region in the shared shell', () => {
    const state: RiskState = { snap: snap(), verdicts: [] };
    const html = renderRiskPage(state);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('class="action-palette"');
    expect(html).toContain('<desk-feed src="/risk/stream" target="risk-live">');
    expect(html).toContain('id="risk-live"');
    expect(html).toContain('nav-link--active');
  });
});
