import { HyperliquidClient, hyperliquidInterval, parseHyperliquidCandles, parseHyperliquidL2 } from './hyperliquid-client';
import { MinimalWs } from './reference-source.interface';

// As HL actually returns it: ms timestamps, string OHLCV, ascending by t.
const SAMPLE = [
  { t: 1780401600000, T: 1780405199999, s: 'BTC', i: '1h', o: '69453.0', c: '68975.0', h: '69529.0', l: '68974.0', v: '2449.8', n: 30799 },
  { t: 1780405200000, T: 1780408799999, s: 'BTC', i: '1h', o: '68975.0', c: '69210.0', h: '69300.0', l: '68900.0', v: '1800.2', n: 21000 },
];

describe('parseHyperliquidCandles', () => {
  it('parses string OHLCV + ms timestamps into ascending Bars', () => {
    const bars = parseHyperliquidCandles('BTC', SAMPLE);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ symbol: 'BTC', open: 69453, close: 68975, high: 69529, low: 68974, volume: 2449.8 });
    expect(bars[0].timestamp).toEqual(new Date(1780401600000));
    expect(bars[0].timestamp.getTime()).toBeLessThan(bars[1].timestamp.getTime());
  });

  it('drops non-positive-close / malformed rows and returns [] for non-arrays', () => {
    expect(parseHyperliquidCandles('X', [{ t: 1, c: '0' }, { t: 2, c: '5' }])).toHaveLength(1);
    expect(parseHyperliquidCandles('X', null)).toEqual([]);
    expect(parseHyperliquidCandles('X', { err: 'nope' })).toEqual([]);
  });
});

describe('hyperliquidInterval', () => {
  it('passes through supported intervals and defaults the rest to 1h', () => {
    expect(hyperliquidInterval('1m')).toBe('1m');
    expect(hyperliquidInterval('1h')).toBe('1h');
    expect(hyperliquidInterval('1d')).toBe('1d');
    expect(hyperliquidInterval('7m')).toBe('1h'); // unsupported → default
  });
});

// As HL actually returns l2Book: { coin, time, levels:[bids desc, asks asc] }, px/sz strings.
const L2_SAMPLE = {
  coin: 'BTC',
  time: 1780504474984,
  levels: [
    [
      { px: '65779.0', sz: '10.37582', n: 49 },
      { px: '65778.0', sz: '16.93215', n: 74 },
    ],
    [
      { px: '65780.0', sz: '0.84857', n: 4 },
      { px: '65781.0', sz: '0.00055', n: 2 },
    ],
  ],
};

describe('parseHyperliquidL2', () => {
  it('parses string px/sz into micros/units with ms ts, bids desc + asks asc', () => {
    const snap = parseHyperliquidL2('BTC', L2_SAMPLE);
    expect(snap.symbol).toBe('BTC');
    expect(snap.ts).toEqual(new Date(1780504474984));
    expect(snap.bids).toHaveLength(2);
    expect(snap.asks).toHaveLength(2);
    expect(snap.bids[0]).toEqual({ priceMicros: 65779000000n, sizeUnits: 10375820n, orderCount: 49 });
    expect(snap.asks[0]).toEqual({ priceMicros: 65780000000n, sizeUnits: 848570n, orderCount: 4 });
    // best bid < best ask, ordering enforced.
    expect(snap.bids[0].priceMicros).toBeGreaterThan(snap.bids[1].priceMicros);
    expect(snap.asks[0].priceMicros).toBeLessThan(snap.asks[1].priceMicros);
    expect(snap.bids[0].priceMicros).toBeLessThan(snap.asks[0].priceMicros);
  });

  it('re-sorts out-of-order wire levels and drops non-positive rows / non-objects', () => {
    const scrambled = {
      time: 1,
      levels: [
        [{ px: '100', sz: '1', n: 1 }, { px: '101', sz: '2', n: 1 }, { px: '99', sz: '0', n: 1 }],
        [{ px: '103', sz: '1', n: 1 }, { px: '102', sz: '1', n: 1 }],
      ],
    };
    const snap = parseHyperliquidL2('X', scrambled);
    expect(snap.bids.map((b) => b.priceMicros)).toEqual([101000000n, 100000000n]); // desc, sz=0 dropped
    expect(snap.asks.map((a) => a.priceMicros)).toEqual([102000000n, 103000000n]); // asc
    const empty = parseHyperliquidL2('X', null);
    expect(empty.bids).toEqual([]);
    expect(empty.asks).toEqual([]);
  });
});

describe('HyperliquidClient', () => {
  it('POSTs an l2Book for the coin and returns a parsed snapshot', async () => {
    let seenBody: any = null;
    const c = new HyperliquidClient({ baseUrl: 'https://hl.test', httpPost: async (_u, body) => ((seenBody = body), L2_SAMPLE) });
    const snap = await c.l2Snapshot('btc');
    expect(seenBody).toEqual({ type: 'l2Book', coin: 'BTC' });
    expect(snap.bids[0].priceMicros).toBe(65779000000n);
  });

  it('openTradeStream derives the wss /ws url from the REST base and subscribes', () => {
    let seenUrl = '';
    const noopWs: MinimalWs = { send: () => undefined, close: () => undefined, addEventListener: () => undefined };
    const c = new HyperliquidClient({ baseUrl: 'https://hl.test', wsFactory: (url) => ((seenUrl = url), noopWs) });
    const stream = c.openTradeStream(['BTC']);
    expect(seenUrl).toBe('wss://hl.test/ws');
    expect(stream.drain('BTC')).toEqual({ aggressiveBuyUnits: 0n, aggressiveSellUnits: 0n, tradeCount: 0 });
    stream.close();
  });

  it('POSTs a candleSnapshot for the coin + maps the interval, returns ascending bars', async () => {
    let seenUrl = '';
    let seenBody: any = null;
    const c = new HyperliquidClient({
      baseUrl: 'https://hl.test',
      httpPost: async (url, body) => {
        seenUrl = url;
        seenBody = body;
        return SAMPLE;
      },
    });
    const bars = await c.klines('btc', '1h', 240);
    expect(seenUrl).toBe('https://hl.test/info');
    expect(seenBody.type).toBe('candleSnapshot');
    expect(seenBody.req.coin).toBe('BTC');
    expect(seenBody.req.interval).toBe('1h');
    expect(seenBody.req.startTime).toBeLessThan(seenBody.req.endTime);
    expect(bars).toHaveLength(2);
  });
});
