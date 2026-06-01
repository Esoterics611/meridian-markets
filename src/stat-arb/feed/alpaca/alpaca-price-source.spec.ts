import { AlpacaDataClient } from './alpaca-data-client';
import { AlpacaPriceSource } from './alpaca-price-source';

describe('AlpacaPriceSource', () => {
  it('returns the latest trade price as 6-decimal micros', async () => {
    const client = new AlpacaDataClient({
      keyId: 'k',
      secret: 's',
      httpGet: async () => ({ trade: { p: 185.5 } }),
    });
    const src = new AlpacaPriceSource(client);
    expect(await src.priceMicros('AAPL')).toBe(185_500_000n); // 185.5 * 1e6
  });
});
