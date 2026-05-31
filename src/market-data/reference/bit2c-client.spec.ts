import { Bit2CClient, parseBit2CTicker } from './bit2c-client';

describe('Bit2CClient', () => {
  it('maps internal symbols to Bit2C pair paths', () => {
    const c = new Bit2CClient();
    expect(c.pairPath('USDCNIS')).toBe('UsdcNis');
    expect(c.pairPath('BTCNIS')).toBe('BtcNis');
    // Fallback CamelCase for an unmapped *NIS code.
    expect(c.pairPath('LTCNIS')).toBe('LtcNis');
  });

  it('parses a ticker into a single latest bar', () => {
    const bar = parseBit2CTicker('USDCNIS', { ll: 3.65, h: 3.71, l: 3.60, av: 3.66 });
    expect(bar).toMatchObject({ symbol: 'USDCNIS', close: 3.65, high: 3.71, low: 3.6, open: 3.65 });
  });

  it('falls back high/low to last when 24h figures are missing', () => {
    const bar = parseBit2CTicker('USDCNIS', { ll: 3.65 });
    expect(bar).toMatchObject({ high: 3.65, low: 3.65, close: 3.65 });
  });

  it('returns null on a missing / bad last price', () => {
    expect(parseBit2CTicker('USDCNIS', {})).toBeNull();
    expect(parseBit2CTicker('USDCNIS', { ll: 0 })).toBeNull();
    expect(parseBit2CTicker('USDCNIS', null)).toBeNull();
  });

  it('builds the ticker URL and returns the bar via injected httpGet', async () => {
    let seen = '';
    const c = new Bit2CClient({
      baseUrl: 'https://bit2c.test',
      httpGet: async (url) => { seen = url; return { ll: 3.7, h: 3.8, l: 3.6 }; },
    });
    const bars = await c.klines('USDCNIS');
    expect(seen).toBe('https://bit2c.test/Exchanges/UsdcNis/Ticker.json');
    expect(bars[0].close).toBe(3.7);
  });
});
