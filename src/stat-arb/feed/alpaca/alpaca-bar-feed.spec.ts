import { AlpacaBarFeed } from './alpaca-bar-feed';
import { AlpacaDataClient } from './alpaca-data-client';

// Offline: a canned httpGet returns a single bars page. No network.
function clientReturning(bars: () => unknown[]): AlpacaDataClient {
  return new AlpacaDataClient({
    keyId: 'k',
    secret: 's',
    httpGet: async () => ({ bars: bars(), next_page_token: null }),
  });
}

function bar(t: string, close: number): unknown {
  return { t, o: 1, h: 2, l: 0.5, c: close, v: 100 };
}

describe('AlpacaBarFeed', () => {
  it('tags the feedId with the data feed', () => {
    expect(new AlpacaBarFeed(clientReturning(() => []), '15m', 'iex').feedId).toBe('alpaca.iex');
    expect(new AlpacaBarFeed(clientReturning(() => []), '15m', 'sip').feedId).toBe('alpaca.sip');
  });

  it('returns the just-closed bar (not the still-forming one) on first poll', async () => {
    const feed = new AlpacaBarFeed(
      clientReturning(() => [bar('2024-01-02T15:00:00Z', 100), bar('2024-01-02T15:15:00Z', 101)]),
      '15m',
    );
    const b = await feed.nextBar('AAPL');
    expect(b).not.toBeNull();
    expect(b!.close).toBe(100);
    expect(b!.symbol).toBe('AAPL');
  });

  it('returns null when no new closed bar since last poll', async () => {
    const feed = new AlpacaBarFeed(
      clientReturning(() => [bar('2024-01-02T15:00:00Z', 100), bar('2024-01-02T15:15:00Z', 101)]),
      '15m',
    );
    expect(await feed.nextBar('AAPL')).not.toBeNull();
    expect(await feed.nextBar('AAPL')).toBeNull();
  });

  it('emits again once the closed bar advances (e.g. next session)', async () => {
    let advanced = false;
    const feed = new AlpacaBarFeed(
      clientReturning(() =>
        advanced
          ? [bar('2024-01-02T15:15:00Z', 101), bar('2024-01-02T15:30:00Z', 102)]
          : [bar('2024-01-02T15:00:00Z', 100), bar('2024-01-02T15:15:00Z', 101)],
      ),
      '15m',
    );
    expect((await feed.nextBar('AAPL'))!.close).toBe(100);
    advanced = true;
    expect((await feed.nextBar('AAPL'))!.close).toBe(101);
  });

  it('emits a single-bar response', async () => {
    const feed = new AlpacaBarFeed(clientReturning(() => [bar('2024-01-02T15:00:00Z', 100)]), '15m');
    expect((await feed.nextBar('AAPL'))!.close).toBe(100);
  });
});
