import { BinancePublicClient } from './binance-public-client';

describe('BinancePublicClient', () => {
  it('maps klines to Bars and embeds the internal symbol', async () => {
    const client = new BinancePublicClient({
      httpGet: async (url) => {
        expect(url).toContain('/api/v3/klines');
        expect(url).toContain('symbol=BTCUSDT');
        expect(url).toContain('interval=1m');
        return [[1_000, '100.5', '101', '99', '100.7', '12.3', 60_999]];
      },
    });
    const bars = await client.klines('BTC', '1m', 1);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ symbol: 'BTC', open: 100.5, close: 100.7, volume: 12.3 });
    expect(bars[0].timestamp.getTime()).toBe(1_000);
  });

  it('parses ticker last price', async () => {
    const client = new BinancePublicClient({
      httpGet: async (url) => {
        expect(url).toContain('/api/v3/ticker/price');
        return { symbol: 'ETHUSDT', price: '3456.78' };
      },
    });
    expect(await client.lastPrice('ETH')).toBe(3456.78);
  });

  it('honours a custom quote asset', async () => {
    const client = new BinancePublicClient({
      quote: 'USDC',
      httpGet: async (url) => {
        expect(url).toContain('symbol=BTCUSDC');
        return { price: '1' };
      },
    });
    await client.lastPrice('BTC');
  });

  it('throws on a non-array klines payload', async () => {
    const client = new BinancePublicClient({ httpGet: async () => ({ code: -1121 }) });
    await expect(client.klines('BTC')).rejects.toThrow(/expected array/);
  });

  it('throws on a bad ticker price', async () => {
    const client = new BinancePublicClient({ httpGet: async () => ({ price: 'nope' }) });
    await expect(client.lastPrice('BTC')).rejects.toThrow(/bad price/);
  });

  it('paginates historicalKlines across pages and stops on a short page', async () => {
    // First call returns a full 1000-bar page, second returns a short page.
    let call = 0;
    const mk = (openMs: number) => [openMs, '1', '1', '1', '1', '1', openMs + 59_999];
    const client = new BinancePublicClient({
      httpGet: async () => {
        call += 1;
        if (call === 1) return Array.from({ length: 1000 }, (_, i) => mk(60_000 * i));
        return [mk(60_000_000), mk(60_060_000)]; // short page -> stop
      },
    });
    const bars = await client.historicalKlines('BTC', '1m', 0, 60_120_000);
    expect(call).toBe(2);
    // 1000 from page 1 + 2 from page 2, minus any with ts >= endMs.
    expect(bars.length).toBe(1002);
  });
});
