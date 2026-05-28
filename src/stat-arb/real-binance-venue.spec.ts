import { RealBinanceVenue } from './real-binance-venue';
import { TradingVenueNotConfiguredError } from './trading-venue.interface';

describe('RealBinanceVenue (dormant)', () => {
  const v = new RealBinanceVenue();

  it('placeOrder throws TradingVenueNotConfiguredError', async () => {
    await expect(
      v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1n, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(TradingVenueNotConfiguredError);
  });

  it('fetchPrice throws TradingVenueNotConfiguredError', async () => {
    await expect(v.fetchPrice('BTC')).rejects.toBeInstanceOf(TradingVenueNotConfiguredError);
  });

  it('reports a stable venueId', () => {
    expect(v.venueId).toBe('binance');
  });
});
