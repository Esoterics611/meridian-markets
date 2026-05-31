import { PythBenchmarksClient, parsePythHistory, pythResolution } from './pyth-benchmarks-client';

describe('PythBenchmarksClient', () => {
  it('maps internal FX codes to Pyth shim symbols', () => {
    const c = new PythBenchmarksClient();
    expect(c.shimSymbol('EURUSD')).toBe('FX.EUR/USD');
    expect(c.shimSymbol('USDILS')).toBe('FX.USD/ILS');
    expect(c.shimSymbol('gbpusd')).toBe('FX.GBP/USD');
    // Unknown 6-char code falls back to a 3/3 split.
    expect(c.shimSymbol('NZDUSD')).toBe('FX.NZD/USD');
    // Already a shim symbol passes through.
    expect(c.shimSymbol('FX.EUR/USD')).toBe('FX.EUR/USD');
  });

  it('maps kline intervals to TradingView resolutions', () => {
    expect(pythResolution('1m')).toBe('1');
    expect(pythResolution('5m')).toBe('5');
    expect(pythResolution('1h')).toBe('60');
    expect(pythResolution('1d')).toBe('1D');
  });

  it('parses a TradingView UDF history payload into bars', () => {
    const raw = {
      s: 'ok',
      t: [1_700_000_000, 1_700_000_060],
      o: [1.08, 1.081],
      h: [1.082, 1.083],
      l: [1.079, 1.08],
      c: [1.081, 1.0815],
    };
    const bars = parsePythHistory('EURUSD', raw);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ symbol: 'EURUSD', open: 1.08, high: 1.082, low: 1.079, close: 1.081 });
    expect(bars[1].timestamp.getTime()).toBe(1_700_000_060 * 1000);
  });

  it('returns [] on a non-ok / malformed payload', () => {
    expect(parsePythHistory('EURUSD', { s: 'no_data' })).toEqual([]);
    expect(parsePythHistory('EURUSD', null)).toEqual([]);
    expect(parsePythHistory('EURUSD', { s: 'ok', t: [1], c: [0] })).toEqual([]); // close<=0 skipped
  });

  it('builds the shim URL and returns parsed bars via injected httpGet', async () => {
    let seen = '';
    const c = new PythBenchmarksClient({
      baseUrl: 'https://example.test',
      httpGet: async (url) => {
        seen = url;
        return { s: 'ok', t: [1_700_000_000], o: [1], h: [1], l: [1], c: [1.07] };
      },
    });
    const bars = await c.klines('EURUSD', '1m', 100);
    expect(seen).toContain('https://example.test/v1/shims/tradingview/history');
    expect(seen).toContain('symbol=FX.EUR%2FUSD');
    expect(seen).toContain('resolution=1');
    expect(bars[0].close).toBe(1.07);
  });
});
