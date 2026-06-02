import { BinanceFundingClient, HttpGet } from './binance-funding-client';

describe('BinanceFundingClient', () => {
  it('parses funding history and maps the internal symbol to a perp market', async () => {
    const calls: string[] = [];
    const httpGet: HttpGet = async (url) => {
      calls.push(url);
      return [
        { symbol: 'BTCUSDT', fundingTime: 1_000, fundingRate: '0.00004438', markPrice: '72779.0' },
        { symbol: 'BTCUSDT', fundingTime: 9_000, fundingRate: '0.00010000', markPrice: '71103.4' },
      ];
    };
    const client = new BinanceFundingClient({ httpGet });
    const pts = await client.fundingHistory('BTC', 0, 100_000);

    expect(calls[0]).toContain('symbol=BTCUSDT');
    expect(calls[0]).toContain('/fapi/v1/fundingRate');
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ symbol: 'BTC', fundingTimeMs: 1_000, fundingRate: 0.00004438, markPrice: 72779.0 });
    expect(pts[1].fundingRate).toBeCloseTo(0.0001, 9);
  });

  it('drops rows at/after endMs and stops on a short page', async () => {
    const httpGet: HttpGet = async () => [
      { symbol: 'BTCUSDT', fundingTime: 10, fundingRate: '0.0001', markPrice: '100' },
      { symbol: 'BTCUSDT', fundingTime: 50, fundingRate: '0.0001', markPrice: '100' }, // == endMs ⇒ excluded
    ];
    const client = new BinanceFundingClient({ httpGet });
    const pts = await client.fundingHistory('BTC', 0, 50);
    expect(pts.map((p) => p.fundingTimeMs)).toEqual([10]);
  });

  it('reads the premium index for current funding', async () => {
    const httpGet: HttpGet = async (url) => {
      expect(url).toContain('/fapi/v1/premiumIndex');
      return {
        symbol: 'ETHUSDT',
        markPrice: '3000.5',
        indexPrice: '3001.0',
        lastFundingRate: '0.00010000',
        nextFundingTime: 1_780_387_200_000,
      };
    };
    const client = new BinanceFundingClient({ httpGet });
    const snap = await client.currentFunding('ETH');
    expect(snap).toEqual({
      symbol: 'ETH',
      lastFundingRate: 0.0001,
      nextFundingTimeMs: 1_780_387_200_000,
      markPrice: 3000.5,
      indexPrice: 3001.0,
    });
  });
});
