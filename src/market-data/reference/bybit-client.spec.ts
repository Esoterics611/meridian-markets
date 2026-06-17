import { BybitClient, bybitInterval } from './bybit-client';

describe('BybitClient (P12 venue)', () => {
  it('maps kline intervals to Bybit v5 tokens', () => {
    expect(bybitInterval('1h')).toBe('60');
    expect(bybitInterval('15m')).toBe('15');
    expect(bybitInterval('4h')).toBe('240');
    expect(bybitInterval('1d')).toBe('D');
    expect(bybitInterval('weird')).toBe('60'); // safe default
  });

  it('maps an internal symbol to the linear perp instrument', () => {
    const c = new BybitClient();
    expect(c.bybitSymbol('BTC')).toBe('BTCUSDT');
    expect(c.bybitSymbol('ethusdt')).toBe('ETHUSDT'); // idempotent on an already-suffixed symbol
  });

  it('parses a canned v5 response into ascending OHLCV bars', async () => {
    let calledUrl = '';
    const httpGet = async (url: string) => {
      calledUrl = url;
      return {
        retCode: 0,
        retMsg: 'OK',
        result: {
          symbol: 'BTCUSDT',
          // Bybit returns NEWEST-FIRST; strings for OHLCV.
          list: [
            ['1700007200000', '102', '103', '101', '102.5', '12.5', '1280000'],
            ['1700003600000', '101', '102', '100', '101', '10', '1010000'],
            ['1700000000000', '100', '101', '99', '100.5', '8', '804000'],
          ],
        },
      };
    };
    const c = new BybitClient({ httpGet });
    const bars = await c.klines('BTC', '1h', 3);
    expect(calledUrl).toContain('category=linear');
    expect(calledUrl).toContain('symbol=BTCUSDT');
    expect(calledUrl).toContain('interval=60');
    expect(bars).toHaveLength(3);
    // ascending by time:
    expect(bars[0].timestamp.getTime()).toBe(1_700_000_000_000);
    expect(bars[2].timestamp.getTime()).toBe(1_700_007_200_000);
    expect(bars[0].close).toBe(100.5);
    expect(bars[2].close).toBe(102.5);
    expect(bars[0].symbol).toBe('BTC');
  });

  it('throws on a Bybit error retCode', async () => {
    const httpGet = async () => ({ retCode: 10001, retMsg: 'params error', result: {} });
    const c = new BybitClient({ httpGet });
    await expect(c.klines('BTC', '1h', 3)).rejects.toThrow(/retCode 10001/);
  });

  it('skips malformed rows and non-positive closes', async () => {
    const httpGet = async () => ({
      retCode: 0,
      result: { list: [['1700000000000', '100', '101', '99', '100.5', '8'], ['bad'], ['1700003600000', '0', '0', '0', '0', '0']] },
    });
    const c = new BybitClient({ httpGet });
    const bars = await c.klines('BTC', '1h', 3);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(100.5);
  });
});
