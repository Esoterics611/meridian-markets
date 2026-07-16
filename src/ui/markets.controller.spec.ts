import { firstValueFrom, take } from 'rxjs';
import { MarketsController, intervalFor } from './markets.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { ReferenceSourceRegistry } from '../market-data/reference/reference-bar-loader';
import { L2Snapshot } from '../market-data/reference/reference-source.interface';
import { BinancePublicClient } from '../stat-arb/feed/binance-public-client';
import { Bar } from '../stat-arb/backtest/bar';

function mmSnap(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: false,
    bookCount: 0,
    capitalUnits: '100000000000',
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    feesUnits: '0',
    fundingUnits: '0',
    netPnlUnits: '0',
    books: [],
    ...over,
  };
}
const fakeTrader = (over: Partial<MmPortfolioSnapshot> = {}) => ({ snapshot: () => mmSnap(over) }) as unknown as MmPortfolioTrader;

function bar(sec: number, close: number): Bar {
  return { symbol: 'BTC', timestamp: new Date(sec * 1000), open: close - 1, high: close + 2, low: close - 2, close, volume: 3 };
}

function l2Snap(): L2Snapshot {
  return {
    symbol: 'BTC',
    ts: new Date(60_000),
    bids: [
      { priceMicros: 100_000_000n, sizeUnits: 2_000_000n, orderCount: 3 },
      { priceMicros: 99_000_000n, sizeUnits: 5_000_000n, orderCount: 1 },
    ],
    asks: [{ priceMicros: 101_000_000n, sizeUnits: 1_500_000n, orderCount: 2 }],
  };
}

/** A registry whose 'hyperliquid' source serves klines + an L2 book. */
function fakeRegistry(opts: { bars?: Bar[]; l2?: L2Snapshot | 'throw' } = {}): ReferenceSourceRegistry {
  const hl = {
    sourceId: 'hyperliquid',
    klines: async () => opts.bars ?? [bar(60, 100), bar(120, 101)],
    l2Snapshot: async () => {
      if (opts.l2 === 'throw') throw new Error('venue down');
      return opts.l2 ?? l2Snap();
    },
  };
  return {
    get: (id: string) => (id === 'hyperliquid' ? hl : undefined),
    bars: async (id: string, sym: string, iv: string, limit: number) => (id === 'hyperliquid' ? hl.klines() : []),
  } as unknown as ReferenceSourceRegistry;
}

const fakeBinance = (bars: Bar[] = [bar(60, 50), bar(120, 51)]) => ({ klines: async () => bars }) as unknown as BinancePublicClient;

/** An MM book quoting BTC on hyperliquid (for the overlay merges). */
const quotingBooks = [
  {
    symbol: 'BTC',
    source: 'hyperliquid',
    bidMicros: '99500000',
    askMicros: '100500000',
    reservationMicros: '100100000',
  },
] as unknown as MmPortfolioSnapshot['books'];

describe('intervalFor', () => {
  it('maps the window to a sane venue interval (1m intraday, 5m days, 1h weeks)', () => {
    expect(intervalFor(6)).toEqual({ interval: '1m', limit: 360 });
    expect(intervalFor(24)).toEqual({ interval: '5m', limit: 288 });
    expect(intervalFor(168)).toEqual({ interval: '1h', limit: 168 });
  });
});

describe('MarketsController', () => {
  it('GET /markets renders picker + strip + chart + ladder for an L2 venue', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const html = await c.page('BTC', 'hyperliquid', '24');
    expect(html).toContain('method="get" action="/markets"');
    expect(html).toContain('<depth-ladder src="/api/market-data/l2/stream?symbol=BTC&venue=hyperliquid">');
    expect(html).toContain('/markets/chart?symbol=BTC&venue=hyperliquid&hours=24');
    // the strip's live spread comes from the L2 mid: (99..101 around 100.5 mid)
    expect(html).toContain('bps');
  });

  it('GET /markets on a depthless venue renders the honest no-ladder note', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const html = await c.page('BTC', 'binance', '24');
    expect(html).not.toContain('<depth-ladder');
    expect(html).toContain('no depth feed for binance');
  });

  it('GET /api/market-data/l2 serves display numbers + our resting quotes merged in', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader({ books: quotingBooks }));
    const frame = await c.l2('BTC', 'hyperliquid');
    expect(frame.enabled).toBe(true);
    if (!frame.enabled) return;
    expect(frame.bids[0]).toEqual({ px: 100, sz: 2, n: 3 });
    expect(frame.asks[0]).toEqual({ px: 101, sz: 1.5, n: 2 });
    expect(frame.ourBid).toBe(99.5);
    expect(frame.ourAsk).toBe(100.5);
  });

  it('GET /api/market-data/l2 refuses honestly: depthless venue / venue error', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const noL2 = await c.l2('BTC', 'binance');
    expect(noL2.enabled).toBe(false);
    if (!noL2.enabled) expect(noL2.reason).toContain('no L2 depth feed');

    const down = new MarketsController(fakeBinance(), fakeRegistry({ l2: 'throw' }), fakeTrader());
    const err = await down.l2('BTC', 'hyperliquid');
    expect(err.enabled).toBe(false);
    if (!err.enabled) expect(err.reason).toContain('unreachable');
  });

  it('GET /markets/chart builds candles + volume and overlays the live book quotes', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader({ books: quotingBooks }));
    const out = await c.chart('BTC', 'hyperliquid', '24');
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    expect(out.panels[0].series[0].type).toBe('candlestick');
    expect(out.panels[1].series[0].name).toBe('volume');
    const lines = out.panels[0].series[0].priceLines!;
    expect(lines.map((l) => l.title)).toEqual(['our bid', 'our ask', 'reservation']);
    expect(out.note).toContain('CURRENT quotes');
  });

  it('GET /markets/chart says so when no book quotes the market (no fabricated lines)', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const out = await c.chart('BTC', 'hyperliquid', '24');
    if (!out.enabled) throw new Error('expected enabled');
    expect(out.panels[0].series[0].priceLines).toBeUndefined();
    expect(out.note).toContain('no MM book quotes this market');
  });

  it('SSE /api/market-data/l2/stream emits raw JSON frames (the ladder parses, not desk-feed)', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const ev = await firstValueFrom(c.l2Stream('BTC', 'hyperliquid').pipe(take(1)));
    const frame = ev.data as { enabled: boolean; bids: unknown[] };
    expect(frame.enabled).toBe(true);
    expect(Array.isArray(frame.bids)).toBe(true);
  });

  it('SSE /markets/stream emits the rendered strip and degrades to FEED DOWN on a dead venue', async () => {
    const c = new MarketsController(fakeBinance(), fakeRegistry(), fakeTrader());
    const ev = await firstValueFrom(c.stream('BTC', 'hyperliquid').pipe(take(1)));
    expect((ev.data as { html: string }).html).toContain('stat-grid');

    const deadRegistry = {
      get: () => ({ sourceId: 'hyperliquid', l2Snapshot: async () => { throw new Error('down'); } }),
      bars: async () => { throw new Error('down'); },
    } as unknown as ReferenceSourceRegistry;
    const dead = new MarketsController(fakeBinance(), deadRegistry, fakeTrader());
    const ev2 = await firstValueFrom(dead.stream('BTC', 'hyperliquid').pipe(take(1)));
    expect((ev2.data as { html: string }).html).toContain('FEED DOWN');
  });
});
