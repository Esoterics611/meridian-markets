import { CcxtBarIngest } from './ccxt-bar-ingest';
import { BarIngestNotConfiguredError } from './bar-ingest.interface';

describe('CcxtBarIngest (dormant)', () => {
  it('has the binance.spot ingestId', () => {
    expect(new CcxtBarIngest().ingestId).toBe('binance.spot');
  });

  it('throws BarIngestNotConfiguredError on nextBatch', async () => {
    await expect(new CcxtBarIngest().nextBatch()).rejects.toBeInstanceOf(BarIngestNotConfiguredError);
  });

  it('error message mentions MOCK_TRADING_ENABLED', async () => {
    await expect(new CcxtBarIngest().nextBatch()).rejects.toThrow(/MOCK_TRADING_ENABLED/);
  });
});
