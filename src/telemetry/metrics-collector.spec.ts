import { PrometheusRegistry } from './prometheus-registry';
import { PrometheusTelemetry } from './prometheus-telemetry';
import { MetricsCollector, MmSnapshotSource } from './metrics-collector';
import { M } from './metric-catalog';
import type { MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import type { MmBookSnapshot } from '../market-making/live/mm-book';

function book(over: Partial<MmBookSnapshot>): MmBookSnapshot {
  return {
    symbol: 'BTC',
    strategyId: 'mm-glft',
    family: 'glft',
    source: 'hyperliquid',
    running: true,
    warm: true,
    barsSeen: 10,
    seededBars: 90,
    lastBarAt: null,
    midMicros: '0',
    bidMicros: null,
    askMicros: null,
    reservationMicros: null,
    halfSpreadMicros: null,
    inventoryUnits: '0',
    capitalUnits: '100000000000',
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    feesUnits: '0',
    fundingUnits: '0',
    netPnlUnits: '0',
    spreadCapturedUnits: '0',
    adverseSelectionUnits: '0',
    fills: 0,
    bidFills: 0,
    askFills: 0,
    blockedQuotes: 0,
    lastVerdict: 'Allow',
    maxDrawdownPct: 0,
    ...over,
  } as MmBookSnapshot;
}

function deskWith(books: MmBookSnapshot[], running: boolean): MmSnapshotSource {
  const sum = (f: (b: MmBookSnapshot) => bigint) => books.reduce((a, b) => a + f(b), 0n);
  const snap: MmPortfolioSnapshot = {
    running,
    bookCount: books.length,
    capitalUnits: sum((b) => BigInt(b.capitalUnits)).toString(),
    equityUnits: sum((b) => BigInt(b.equityUnits)).toString(),
    realisedPnlUnits: sum((b) => BigInt(b.realisedPnlUnits)).toString(),
    unrealisedPnlUnits: sum((b) => BigInt(b.unrealisedPnlUnits)).toString(),
    feesUnits: sum((b) => BigInt(b.feesUnits)).toString(),
    fundingUnits: sum((b) => BigInt(b.fundingUnits)).toString(),
    netPnlUnits: sum((b) => BigInt(b.netPnlUnits)).toString(),
    books,
  };
  return { snapshot: () => snap };
}

describe('MetricsCollector — snapshot → metrics mapping (DC-3)', () => {
  let registry: PrometheusRegistry;
  beforeEach(() => {
    registry = new PrometheusRegistry();
    new PrometheusTelemetry(registry); // registers the catalog
  });

  it('does nothing when disabled', () => {
    const c = new MetricsCollector(registry, deskWith([book({})], true), false);
    c.collect();
    expect(registry.gauge(M.deskEquity)!.value()).toBeUndefined();
  });

  it('maps desk aggregate + per-book gauges with bounded labels', () => {
    const books = [
      book({ symbol: 'BTC', source: 'hyperliquid', strategyId: 'mm-glft', equityUnits: '100001000000', netPnlUnits: '1000000', bidFills: 3, askFills: 2, blockedQuotes: 1, lastVerdict: 'Pause', maxDrawdownPct: 0.5, inventoryUnits: '500000' }),
      book({ symbol: 'ETH', source: 'hyperliquid', strategyId: 'mm-glft', equityUnits: '99999000000', netPnlUnits: '-1000000' }),
    ];
    const c = new MetricsCollector(registry, deskWith(books, true), true);
    c.collect();

    expect(registry.gauge(M.deskRunning)!.value()).toBe(1);
    expect(registry.gauge(M.deskBookCount)!.value()).toBe(2);
    expect(registry.gauge(M.deskEquity)!.value()).toBe(200_000_000_000);
    expect(registry.gauge(M.deskNav)!.value()).toBe(200_000_000_000);

    expect(registry.gauge(M.bookEquity)!.value({ book: 'BTC', source: 'hyperliquid', strategy: 'mm-glft' })).toBe(100_001_000_000);
    expect(registry.gauge(M.bookNetPnl)!.value({ book: 'BTC' })).toBe(1_000_000);
    expect(registry.gauge(M.bookInventory)!.value({ book: 'BTC' })).toBe(500_000);
    expect(registry.gauge(M.bookFills)!.value({ book: 'BTC', side: 'bid' })).toBe(3);
    expect(registry.gauge(M.bookFills)!.value({ book: 'BTC', side: 'ask' })).toBe(2);
    expect(registry.gauge(M.bookBlockedQuotes)!.value({ book: 'BTC' })).toBe(1);
    expect(registry.gauge(M.bookMaxDrawdownPct)!.value({ book: 'BTC' })).toBe(0.5);

    // risk verdict state gauge: 1 for the active verdict, 0 for the others
    expect(registry.gauge(M.bookRiskVerdict)!.value({ book: 'BTC', verdict: 'Pause' })).toBe(1);
    expect(registry.gauge(M.bookRiskVerdict)!.value({ book: 'BTC', verdict: 'Allow' })).toBe(0);
  });

  it('feed_last_bar_age reflects the bar timestamp, set only for books with a bar', () => {
    const now = 1_000_000;
    const books = [
      book({ symbol: 'BTC', source: 'hyperliquid', lastBarAt: new Date(now - 30_000).toISOString() }),
      book({ symbol: 'ETH', source: 'hyperliquid', lastBarAt: null }),
    ];
    const c = new MetricsCollector(registry, deskWith(books, true), true, () => now);
    c.collect();
    expect(registry.gauge(M.feedLastBarAge)!.value({ source: 'hyperliquid', symbol: 'BTC' })).toBe(30);
    expect(registry.gauge(M.feedLastBarAge)!.value({ source: 'hyperliquid', symbol: 'ETH' })).toBeUndefined();
  });

  it('resets per-book series each scrape so a removed book vanishes', () => {
    const c1 = new MetricsCollector(registry, deskWith([book({ symbol: 'BTC' }), book({ symbol: 'ETH' })], true), true);
    c1.collect();
    expect(registry.gauge(M.bookNetPnl)!.value({ book: 'ETH' })).toBe(0);
    // next scrape: ETH removed
    const c2 = new MetricsCollector(registry, deskWith([book({ symbol: 'BTC' })], true), true);
    c2.collect();
    expect(registry.gauge(M.bookNetPnl)!.value({ book: 'ETH' })).toBeUndefined();
    expect(registry.gauge(M.bookNetPnl)!.value({ book: 'BTC' })).toBe(0);
  });
});
