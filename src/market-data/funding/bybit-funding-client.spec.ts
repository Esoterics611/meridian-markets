import { BybitFundingClient } from './bybit-funding-client';

// Offline specs with canned v5 payloads — the parser + the BACKWARDS pagination
// (Bybit serves newest-first; the interface contract is chronological).

const H8 = 8 * 3_600_000;

const envelope = (list: unknown[]): unknown => ({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list } });
const row = (t: number, rate: string): unknown => ({ symbol: 'BTCUSDT', fundingRate: rate, fundingRateTimestamp: String(t) });

describe('BybitFundingClient.fundingHistory', () => {
  it('returns chronological points from a newest-first page and honours [startMs, endMs)', async () => {
    const urls: string[] = [];
    const client = new BybitFundingClient({
      httpGet: async (url) => {
        urls.push(url);
        // Newest first, one outside the window on each end.
        return envelope([row(4 * H8, '0.0004'), row(3 * H8, '0.0003'), row(2 * H8, '0.0002'), row(H8, '0.0001')]);
      },
    });
    const points = await client.fundingHistory('BTC', 2 * H8, 4 * H8);
    expect(urls[0]).toContain('/v5/market/funding/history?category=linear&symbol=BTCUSDT');
    expect(points.map((p) => p.fundingTimeMs)).toEqual([2 * H8, 3 * H8]); // chronological, end-exclusive
    expect(points.map((p) => p.fundingRate)).toEqual([0.0002, 0.0003]);
    expect(points[0].symbol).toBe('BTC');
  });

  it('paginates BACKWARDS through full pages (endTime ← oldest − 1)', async () => {
    // Page 1: settlements 201..400 (newest-first, 200 rows); page 2: 1..200.
    const pageFor = (endMs: number): unknown[] => {
      const newestIdx = Math.floor(endMs / H8);
      const rows: unknown[] = [];
      for (let i = newestIdx; i > Math.max(0, newestIdx - 200); i--) rows.push(row(i * H8, '0.0001'));
      return rows;
    };
    const ends: number[] = [];
    const client = new BybitFundingClient({
      httpGet: async (url) => {
        const end = Number(new URL(url).searchParams.get('endTime'));
        ends.push(end);
        return envelope(pageFor(end));
      },
    });
    const points = await client.fundingHistory('BTC', H8, 401 * H8);
    expect(points).toHaveLength(400);
    expect(points[0].fundingTimeMs).toBe(H8); // chronological after the backward walk
    expect(points[399].fundingTimeMs).toBe(400 * H8);
    // Each request ends just before the previous page's oldest row.
    expect(ends).toEqual([401 * H8, 202 * H8 - 1, 2 * H8 - 1]);
  });

  it('throws on a non-zero retCode', async () => {
    const client = new BybitFundingClient({ httpGet: async () => ({ retCode: 10001, retMsg: 'params error' }) });
    await expect(client.fundingHistory('BTC', 0, H8)).rejects.toThrow(/retCode 10001/);
  });
});

describe('BybitFundingClient.currentFunding', () => {
  it('parses the linear ticker', async () => {
    const client = new BybitFundingClient({
      httpGet: async (url) => {
        expect(url).toContain('/v5/market/tickers?category=linear&symbol=ETHUSDT');
        return {
          retCode: 0,
          result: { list: [{ symbol: 'ETHUSDT', markPrice: '3000.5', indexPrice: '3000.1', fundingRate: '0.00012', nextFundingTime: '1720000000000' }] },
        };
      },
    });
    const snap = await client.currentFunding('ETH');
    expect(snap).toEqual({ symbol: 'ETH', lastFundingRate: 0.00012, nextFundingTimeMs: 1_720_000_000_000, markPrice: 3000.5, indexPrice: 3000.1 });
  });

  it('throws on an empty/bad ticker payload', async () => {
    const client = new BybitFundingClient({ httpGet: async () => ({ retCode: 0, result: { list: [] } }) });
    await expect(client.currentFunding('ETH')).rejects.toThrow(/bad response/);
  });
});
