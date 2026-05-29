import { BinanceBackfillService } from './binance-backfill.service';
import { BinancePublicClient } from '../../stat-arb/feed/binance-public-client';
import { MarketDataRepository, MarketBarInsert } from '../market-data.repository';
import { Bar } from '../../stat-arb/backtest/bar';

function bar(symbol: string, t: number): Bar {
  return { symbol, timestamp: new Date(t), open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

describe('BinanceBackfillService', () => {
  it('fetches per-symbol history and writes it to the repository', async () => {
    const client = {
      historicalKlines: jest.fn(async (sym: string) => [bar(sym, 1), bar(sym, 2)]),
    } as unknown as BinancePublicClient;

    const captured: MarketBarInsert[] = [];
    const repo = {
      insertBars: jest.fn(async (rows: MarketBarInsert[]) => {
        captured.push(...rows);
        return rows.length;
      }),
    } as unknown as MarketDataRepository;

    const svc = new BinanceBackfillService(client, repo);
    const res = await svc.backfill({ symbols: ['BTC', 'ETH'], fromMs: 0, toMs: 10, interval: '1m' });

    expect(res).toEqual([
      { symbol: 'BTC', fetched: 2, inserted: 2 },
      { symbol: 'ETH', fetched: 2, inserted: 2 },
    ]);
    expect(captured).toHaveLength(4);
    expect(captured[0]).toMatchObject({ venue: 'binance.spot', symbol: 'BTC' });
    expect(client.historicalKlines).toHaveBeenCalledWith('BTC', '1m', 0, 10);
  });
});
