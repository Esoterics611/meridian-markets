import { RealCcxtBarFeed } from './real-ccxt-feed';
import { BarFeedNotConfiguredError } from './live-feed.interface';

describe('RealCcxtBarFeed (dormant)', () => {
  it('has the binance.spot feedId', () => {
    expect(new RealCcxtBarFeed().feedId).toBe('binance.spot');
  });

  it('throws BarFeedNotConfiguredError on nextBar', async () => {
    await expect(new RealCcxtBarFeed().nextBar('BTC')).rejects.toBeInstanceOf(
      BarFeedNotConfiguredError,
    );
  });

  it('error message mentions MOCK_TRADING_ENABLED', async () => {
    await expect(new RealCcxtBarFeed().nextBar('BTC')).rejects.toThrow(
      /MOCK_TRADING_ENABLED/,
    );
  });
});
