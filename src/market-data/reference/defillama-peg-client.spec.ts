import { DefiLlamaPegClient, parseDefiLlamaPeg } from './defillama-peg-client';

const SAMPLE = {
  peggedAssets: [
    { symbol: 'USDC', price: 0.9998 },
    { symbol: 'USDT', price: 1.0001 },
    { symbol: 'DAI', price: null },
  ],
};

describe('DefiLlamaPegClient', () => {
  it('extracts a stablecoin peg price by symbol (case-insensitive)', () => {
    expect(parseDefiLlamaPeg('USDC', SAMPLE)).toBe(0.9998);
    expect(parseDefiLlamaPeg('usdt', SAMPLE)).toBe(1.0001);
  });

  it('returns null for a missing / null / malformed price', () => {
    expect(parseDefiLlamaPeg('DAI', SAMPLE)).toBeNull(); // null price
    expect(parseDefiLlamaPeg('FRAX', SAMPLE)).toBeNull(); // not present
    expect(parseDefiLlamaPeg('USDC', {})).toBeNull();
    expect(parseDefiLlamaPeg('USDC', null)).toBeNull();
  });

  it('returns a single latest bar via injected httpGet', async () => {
    let seen = '';
    const c = new DefiLlamaPegClient({
      baseUrl: 'https://llama.test',
      httpGet: async (url) => { seen = url; return SAMPLE; },
    });
    const bars = await c.klines('USDC');
    expect(seen).toBe('https://llama.test/stablecoins?includePrices=true');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ symbol: 'USDC', close: 0.9998, open: 0.9998 });
  });

  it('returns [] when the symbol has no usable price', async () => {
    const c = new DefiLlamaPegClient({ httpGet: async () => SAMPLE });
    expect(await c.klines('DAI')).toEqual([]);
  });
});
