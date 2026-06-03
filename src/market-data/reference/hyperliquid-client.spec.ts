import { HyperliquidClient, hyperliquidInterval, parseHyperliquidCandles } from './hyperliquid-client';

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

describe('HyperliquidClient', () => {
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
