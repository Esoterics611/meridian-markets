import { BinancePublicBarFeed } from './binance-public-bar-feed';
import { BinancePublicClient } from './binance-public-client';

// Offline: a canned httpGet returns klines. No network.
function clientReturning(klinesBySymbol: Record<string, unknown>): BinancePublicClient {
  return new BinancePublicClient({
    httpGet: async (url: string) => {
      const m = url.match(/symbol=([A-Z]+)/);
      const market = m ? m[1] : '';
      return klinesBySymbol[market] ?? [];
    },
  });
}

function kline(openMs: number, close: number): unknown {
  return [openMs, '1', '2', '0.5', String(close), '100', openMs + 59_999];
}

describe('BinancePublicBarFeed', () => {
  it('has the binance.spot feedId', () => {
    expect(new BinancePublicBarFeed(clientReturning({})).feedId).toBe('binance.spot');
  });

  it('returns the just-closed bar (index -2) on first poll', async () => {
    const client = clientReturning({
      BTCUSDT: [kline(1_000, 100), kline(61_000, 101)],
    });
    const feed = new BinancePublicBarFeed(client);
    const bar = await feed.nextBar('BTC');
    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(100); // the closed bar, not the forming one
    expect(bar!.symbol).toBe('BTC');
  });

  it('returns null when no new closed bar since last poll', async () => {
    const client = clientReturning({ BTCUSDT: [kline(1_000, 100), kline(61_000, 101)] });
    const feed = new BinancePublicBarFeed(client);
    expect(await feed.nextBar('BTC')).not.toBeNull();
    expect(await feed.nextBar('BTC')).toBeNull(); // same closed bar
  });

  it('emits again once the closed bar advances', async () => {
    let advanced = false;
    const client = new BinancePublicClient({
      httpGet: async () =>
        advanced
          ? [kline(61_000, 101), kline(121_000, 102)]
          : [kline(1_000, 100), kline(61_000, 101)],
    });
    const feed = new BinancePublicBarFeed(client);
    const first = await feed.nextBar('BTC');
    expect(first!.close).toBe(100);
    advanced = true;
    const second = await feed.nextBar('BTC');
    expect(second!.close).toBe(101);
  });

  it('handles a single-kline response by emitting it', async () => {
    const client = clientReturning({ BTCUSDT: [kline(1_000, 100)] });
    const feed = new BinancePublicBarFeed(client);
    const bar = await feed.nextBar('BTC');
    expect(bar!.close).toBe(100);
  });
});
