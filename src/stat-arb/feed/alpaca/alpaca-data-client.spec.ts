import { AlpacaDataClient, intervalMinutes, toAlpacaTimeframe } from './alpaca-data-client';

const KEYED = { keyId: 'k-123', secret: 's-456' };

describe('AlpacaDataClient', () => {
  it('sends APCA auth headers and requests split/dividend-adjusted bars', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const client = new AlpacaDataClient({
      ...KEYED,
      httpGet: async (url, headers) => {
        seenUrl = url;
        seenHeaders = headers;
        return {
          symbol: 'AAPL',
          bars: [{ t: '2024-01-02T15:00:00Z', o: 185.1, h: 186, l: 184.9, c: 185.6, v: 1200 }],
          next_page_token: null,
        };
      },
    });
    const bars = await client.historicalBars('AAPL', '15m', Date.parse('2024-01-02'), Date.parse('2024-01-03'));

    // Auth — the equity-specific difference from Binance: a key is required.
    expect(seenHeaders['APCA-API-KEY-ID']).toBe('k-123');
    expect(seenHeaders['APCA-API-SECRET-KEY']).toBe('s-456');
    // adjustment=all is non-negotiable (splits/dividends would fake spreads).
    expect(seenUrl).toContain('/v2/stocks/AAPL/bars');
    expect(seenUrl).toContain('timeframe=15Min');
    expect(seenUrl).toContain('adjustment=all');
    expect(seenUrl).toContain('feed=iex');
    // Maps to the shared Bar shape.
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ symbol: 'AAPL', open: 185.1, close: 185.6, volume: 1200 });
    expect(bars[0].timestamp.getTime()).toBe(Date.parse('2024-01-02T15:00:00Z'));
  });

  it('paginates historicalBars via next_page_token', async () => {
    const urls: string[] = [];
    const client = new AlpacaDataClient({
      ...KEYED,
      httpGet: async (url) => {
        urls.push(url);
        if (!url.includes('page_token=')) {
          return {
            bars: [{ t: '2024-01-02T15:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }],
            next_page_token: 'TOK-2',
          };
        }
        return {
          bars: [{ t: '2024-01-02T15:15:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }],
          next_page_token: null,
        };
      },
    });
    const bars = await client.historicalBars('AAPL', '15m', 0, Date.parse('2024-01-03'));
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toContain('page_token=');
    expect(urls[1]).toContain('page_token=TOK-2');
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.close)).toEqual([1, 2]);
  });

  it('drops bars at or past endMs', async () => {
    const client = new AlpacaDataClient({
      ...KEYED,
      httpGet: async () => ({
        bars: [
          { t: '2024-01-02T15:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
          { t: '2024-01-02T16:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }, // == endMs -> dropped
        ],
        next_page_token: null,
      }),
    });
    const bars = await client.historicalBars('AAPL', '15m', 0, Date.parse('2024-01-02T16:00:00Z'));
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(1);
  });

  it('recentBars returns the tail of the window', async () => {
    const client = new AlpacaDataClient({
      ...KEYED,
      httpGet: async () => ({
        bars: [
          { t: '2024-01-02T15:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
          { t: '2024-01-02T15:15:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 },
          { t: '2024-01-02T15:30:00Z', o: 3, h: 3, l: 3, c: 3, v: 3 },
        ],
        next_page_token: null,
      }),
    });
    const bars = await client.recentBars('AAPL', '15m', 2);
    expect(bars.map((b) => b.close)).toEqual([2, 3]);
  });

  it('parses the latest trade price', async () => {
    const client = new AlpacaDataClient({
      ...KEYED,
      httpGet: async (url) => {
        expect(url).toContain('/v2/stocks/MSFT/trades/latest');
        return { symbol: 'MSFT', trade: { p: 412.34, s: 100 } };
      },
    });
    expect(await client.latestTrade('MSFT')).toBe(412.34);
  });

  it('throws on a bad latest-trade price', async () => {
    const client = new AlpacaDataClient({ ...KEYED, httpGet: async () => ({ trade: { p: 0 } }) });
    await expect(client.latestTrade('MSFT')).rejects.toThrow(/bad price/);
  });

  it('refuses to call the wire without a key/secret', async () => {
    const client = new AlpacaDataClient({ httpGet: async () => ({}) });
    await expect(client.historicalBars('AAPL', '15m', 0, 1)).rejects.toThrow(/not configured/);
    await expect(client.latestTrade('AAPL')).rejects.toThrow(/not configured/);
  });
});

describe('toAlpacaTimeframe', () => {
  it.each([
    ['1m', '1Min'],
    ['5m', '5Min'],
    ['15m', '15Min'],
    ['30m', '30Min'],
    ['1h', '1Hour'],
    ['4h', '4Hour'],
    ['1d', '1Day'],
  ])('maps %s -> %s', (engine, alpaca) => {
    expect(toAlpacaTimeframe(engine)).toBe(alpaca);
  });

  it('passes through an already-Alpaca timeframe', () => {
    expect(toAlpacaTimeframe('15Min')).toBe('15Min');
    expect(toAlpacaTimeframe('1Day')).toBe('1Day');
  });

  it('throws on an unsupported interval', () => {
    expect(() => toAlpacaTimeframe('1w')).toThrow(/unsupported/);
  });
});

describe('intervalMinutes', () => {
  it.each([
    ['1m', 1],
    ['15m', 15],
    ['1h', 60],
    ['4h', 240],
    ['1d', 1440],
    ['15Min', 15],
    ['1Hour', 60],
  ])('%s -> %i minutes', (interval, mins) => {
    expect(intervalMinutes(interval)).toBe(mins);
  });
});
