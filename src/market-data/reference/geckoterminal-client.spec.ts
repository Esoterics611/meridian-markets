import {
  GeckoTerminalClient,
  geckoTimeframe,
  parseGeckoTerminalOhlcv,
} from './geckoterminal-client';

// Newest-first, as GeckoTerminal actually returns it.
const SAMPLE = {
  data: {
    attributes: {
      ohlcv_list: [
        [1780452000, 1861.25, 1861.26, 1854.77, 1854.94, 14578495.1],
        [1780448400, 1866.35, 1866.35, 1855.35, 1861.26, 10096719.9],
        [1780444800, 1856.59, 1870.79, 1856.59, 1866.35, 7739788.3],
      ],
    },
  },
};

describe('parseGeckoTerminalOhlcv', () => {
  it('parses ohlcv_list and sorts ascending (GT returns newest-first)', () => {
    const bars = parseGeckoTerminalOhlcv('WETHUSDC', SAMPLE);
    expect(bars).toHaveLength(3);
    // ascending by timestamp
    expect(bars[0].timestamp.getTime()).toBeLessThan(bars[2].timestamp.getTime());
    expect(bars[0]).toMatchObject({ symbol: 'WETHUSDC', open: 1856.59, close: 1866.35 });
    expect(bars[2]).toMatchObject({ close: 1854.94, volume: 14578495.1 });
    expect(bars[0].timestamp).toEqual(new Date(1780444800 * 1000));
  });

  it('drops malformed / non-positive-close / short rows', () => {
    const dirty = {
      data: {
        attributes: {
          ohlcv_list: [
            [1780444800, 1, 1, 1, 0, 5], // close <= 0
            [1780448400, 2, 2, 2], // too short
            'nope',
            [1780452000, 3, 3, 3, 3.5, 7], // good
          ],
        },
      },
    };
    const bars = parseGeckoTerminalOhlcv('X', dirty);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(3.5);
  });

  it('returns [] for missing / malformed payloads', () => {
    expect(parseGeckoTerminalOhlcv('X', {})).toEqual([]);
    expect(parseGeckoTerminalOhlcv('X', null)).toEqual([]);
    expect(parseGeckoTerminalOhlcv('X', { data: { attributes: {} } })).toEqual([]);
  });
});

describe('geckoTimeframe', () => {
  it('maps kline intervals to GT {timeframe, aggregate}', () => {
    expect(geckoTimeframe('1m')).toEqual({ timeframe: 'minute', aggregate: 1 });
    expect(geckoTimeframe('5m')).toEqual({ timeframe: 'minute', aggregate: 5 });
    expect(geckoTimeframe('15m')).toEqual({ timeframe: 'minute', aggregate: 15 });
    expect(geckoTimeframe('1h')).toEqual({ timeframe: 'hour', aggregate: 1 });
    expect(geckoTimeframe('4h')).toEqual({ timeframe: 'hour', aggregate: 4 });
    expect(geckoTimeframe('1d')).toEqual({ timeframe: 'day', aggregate: 1 });
    expect(geckoTimeframe('garbage')).toEqual({ timeframe: 'hour', aggregate: 1 });
  });
});

describe('GeckoTerminalClient', () => {
  it('resolves a mapped symbol to its network/pool path', () => {
    const c = new GeckoTerminalClient();
    expect(c.poolPath('WETHUSDC')).toBe('eth/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
    expect(c.poolPath('wethusdc')).toBe('eth/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  });

  it('passes through a raw network/pool symbol unmapped', () => {
    const c = new GeckoTerminalClient();
    expect(c.poolPath('base/0xabc')).toBe('base/0xabc');
  });

  it('builds the OHLCV URL with pools segment + interval mapping, returns ascending bars', async () => {
    let seen = '';
    const c = new GeckoTerminalClient({
      baseUrl: 'https://gt.test/api/v2',
      httpGet: async (url) => {
        seen = url;
        return SAMPLE;
      },
    });
    const bars = await c.klines('WETHUSDC', '1h', 240);
    expect(seen).toBe(
      'https://gt.test/api/v2/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?aggregate=1&limit=240&currency=usd',
    );
    expect(bars).toHaveLength(3);
    expect(bars[0].timestamp.getTime()).toBeLessThan(bars[2].timestamp.getTime());
  });

  it('clamps limit to [1, 1000]', async () => {
    let seen = '';
    const c = new GeckoTerminalClient({
      httpGet: async (url) => {
        seen = url;
        return { data: { attributes: { ohlcv_list: [] } } };
      },
    });
    await c.klines('eth/0xpool', '15m', 5000);
    expect(seen).toContain('/networks/eth/pools/0xpool/ohlcv/minute?aggregate=15&limit=1000');
  });
});
