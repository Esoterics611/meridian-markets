import {
  HyperliquidFundingClient,
  HYPERLIQUID_PERIODS_PER_YEAR,
  parseHyperliquidAssetCtxs,
  parseHyperliquidFundingHistory,
} from './hyperliquid-funding-client';

// As HL actually returns fundingHistory: hourly rows, string rate, ms time, NO mark.
const FH_SAMPLE = [
  { coin: 'BTC', fundingRate: '0.0000125', premium: '-0.0002138945', time: 1780513200000 },
  { coin: 'BTC', fundingRate: '0.0000125', premium: '-0.0001678726', time: 1780516800000 },
];

// As HL actually returns metaAndAssetCtxs: [ {universe:[{name}]}, [ctx] ] parallel.
const CTX_SAMPLE = [
  { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
  [
    { funding: '0.0000125', markPx: '63166.0', oraclePx: '63199.0' },
    { funding: '-0.00003', markPx: '1803.0', oraclePx: '1804.0' },
  ],
];

describe('parseHyperliquidFundingHistory', () => {
  it('parses hourly rows into FundingPoints with markPrice 0 (HL omits mark)', () => {
    const pts = parseHyperliquidFundingHistory('BTC', FH_SAMPLE);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ symbol: 'BTC', fundingTimeMs: 1780513200000, fundingRate: 0.0000125, markPrice: 0 });
  });

  it('drops rows at/after endMs and returns [] for non-arrays', () => {
    expect(parseHyperliquidFundingHistory('BTC', FH_SAMPLE, 1780516800000)).toHaveLength(1); // 2nd row == endMs dropped
    expect(parseHyperliquidFundingHistory('BTC', null)).toEqual([]);
  });
});

describe('parseHyperliquidAssetCtxs', () => {
  it('finds the coin by parallel index and reads funding/mark/oracle', () => {
    const snap = parseHyperliquidAssetCtxs('ETH', CTX_SAMPLE, 1780516800000);
    expect(snap.lastFundingRate).toBe(-0.00003);
    expect(snap.markPrice).toBe(1803);
    expect(snap.indexPrice).toBe(1804);
    // next funding is the next hour boundary
    expect(snap.nextFundingTimeMs).toBe(Math.ceil(1780516800000 / 3_600_000) * 3_600_000);
  });

  it('throws on a missing coin or malformed shape', () => {
    expect(() => parseHyperliquidAssetCtxs('DOGE', CTX_SAMPLE)).toThrow(/not in universe/);
    expect(() => parseHyperliquidAssetCtxs('BTC', null)).toThrow(/bad response shape/);
  });
});

describe('HyperliquidFundingClient', () => {
  it('POSTs fundingHistory for the coin and parses the page', async () => {
    let seenBody: any = null;
    const c = new HyperliquidFundingClient({
      baseUrl: 'https://hl.test',
      httpPost: async (_u, body) => ((seenBody = body), FH_SAMPLE),
    });
    const pts = await c.fundingHistory('btc', 1780513200000, 1780600000000);
    expect(seenBody).toMatchObject({ type: 'fundingHistory', coin: 'BTC' });
    expect(pts).toHaveLength(2);
  });

  it('POSTs metaAndAssetCtxs for currentFunding', async () => {
    let seenBody: any = null;
    const c = new HyperliquidFundingClient({
      baseUrl: 'https://hl.test',
      httpPost: async (_u, body) => ((seenBody = body), CTX_SAMPLE),
    });
    const snap = await c.currentFunding('BTC');
    expect(seenBody).toEqual({ type: 'metaAndAssetCtxs' });
    expect(snap.lastFundingRate).toBe(0.0000125);
  });

  it('exposes the hourly periods-per-year constant', () => {
    expect(HYPERLIQUID_PERIODS_PER_YEAR).toBe(8760);
  });
});
