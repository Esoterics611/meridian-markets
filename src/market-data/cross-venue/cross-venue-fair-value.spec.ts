import { BasisSnapshot, ICrossVenueFairValue, MockCrossVenueFairValue } from './cross-venue-fair-value.interface';
import { CrossVenueFairValue } from './cross-venue-fair-value';
import { L2Snapshot } from '../reference/reference-source.interface';

// Unit tests run offline — inject canned responses for both venue clients.

function makeL2Snapshot(symbol: string, bidPriceMicros: bigint, askPriceMicros: bigint, serverTsMs: number): L2Snapshot {
  return {
    symbol,
    ts: new Date(serverTsMs),
    bids: [{ priceMicros: bidPriceMicros, sizeUnits: 1_000_000n, orderCount: 1 }],
    asks: [{ priceMicros: askPriceMicros, sizeUnits: 1_000_000n, orderCount: 1 }],
  };
}

describe('MockCrossVenueFairValue', () => {
  it('returns zero basis by default', async () => {
    const mock = new MockCrossVenueFairValue({ binanceMid: 50_000 });
    const snap = await mock.getBasis('BTC');
    expect(snap.basis).toBe(0);
    expect(snap.basisBps).toBe(0);
    expect(snap.binanceMid).toBe(50_000);
    expect(snap.hlMid).toBe(50_000);
  });

  it('respects configured basis', async () => {
    const mock = new MockCrossVenueFairValue({ binanceMid: 50_000, basis: 10 });
    const snap = await mock.getBasis('BTC');
    expect(snap.basis).toBe(10);
    expect(snap.hlMid).toBe(50_010);
    expect(snap.basisBps).toBeCloseTo(2, 1); // 10/50000 × 10000 = 2bps
  });

  it('configures hlDataAgeMs', async () => {
    const mock = new MockCrossVenueFairValue({ hlDataAgeMs: 150 });
    const snap = await mock.getBasis('ETH');
    expect(snap.hlDataAgeMs).toBe(150);
  });
});

describe('CrossVenueFairValue', () => {
  function makeClients(binancePrice: number, hlBid: number, hlAsk: number, hlServerTsMs: number) {
    const binance = {
      lastPrice: jest.fn().mockResolvedValue(binancePrice),
    } as unknown as import('../../stat-arb/feed/binance-public-client').BinancePublicClient;

    const hl = {
      l2Snapshot: jest.fn().mockResolvedValue(
        makeL2Snapshot('BTC', BigInt(Math.round(hlBid * 1_000_000)), BigInt(Math.round(hlAsk * 1_000_000)), hlServerTsMs),
      ),
    } as unknown as import('../reference/hyperliquid-client').HyperliquidClient;

    return { binance, hl };
  }

  it('computes basis = hlMid − binanceMid', async () => {
    const now = Date.now();
    const { binance, hl } = makeClients(50_000, 50_020, 50_040, now - 80);
    const fv = new CrossVenueFairValue(binance, hl);
    const snap = await fv.getBasis('BTC');

    expect(snap.binanceMid).toBe(50_000);
    expect(snap.hlMid).toBeCloseTo(50_030, 3); // (50020 + 50040) / 2
    expect(snap.basis).toBeCloseTo(30, 3);
    expect(snap.basisBps).toBeCloseTo(30 / 50_000 * 10_000, 3); // ~6bps
  });

  it('computes hlDataAgeMs from server ts vs fetch time', async () => {
    const serverTsMs = Date.now() - 120; // HL server timestamp 120ms ago
    const { binance, hl } = makeClients(3_000, 3_001, 3_002, serverTsMs);
    const fv = new CrossVenueFairValue(binance, hl);
    const snap = await fv.getBasis('ETH');

    // hlDataAgeMs ≥ 120ms (server ts was 120ms before fetch; test runs fast so ≤ 300ms)
    expect(snap.hlDataAgeMs).toBeGreaterThanOrEqual(120);
    expect(snap.hlDataAgeMs).toBeLessThan(500);
  });

  it('handles empty HL book gracefully (mid = 0)', async () => {
    const binance = {
      lastPrice: jest.fn().mockResolvedValue(50_000),
    } as unknown as import('../../stat-arb/feed/binance-public-client').BinancePublicClient;
    const hl = {
      l2Snapshot: jest.fn().mockResolvedValue({ symbol: 'BTC', ts: new Date(), bids: [], asks: [] } as L2Snapshot),
    } as unknown as import('../reference/hyperliquid-client').HyperliquidClient;

    const fv = new CrossVenueFairValue(binance, hl);
    const snap = await fv.getBasis('BTC');
    expect(snap.hlMid).toBe(0);
    expect(snap.basis).toBe(-50_000);
    expect(snap.basisBps).toBeCloseTo(-10_000, 0); // -100%
  });

  it('satisfies the ICrossVenueFairValue interface', () => {
    const { binance, hl } = makeClients(1, 1, 1, Date.now());
    const fv: ICrossVenueFairValue = new CrossVenueFairValue(binance, hl);
    expect(typeof fv.getBasis).toBe('function');
  });
});

describe('BasisSnapshot invariants', () => {
  it('basisBps = basis / binanceMid * 10000', async () => {
    const mock = new MockCrossVenueFairValue({ binanceMid: 2_000, basis: 5 });
    const snap = await mock.getBasis('ETH');
    expect(snap.basisBps).toBeCloseTo((snap.basis / snap.binanceMid) * 10_000, 5);
  });

  it('returns hlBook in snapshot', async () => {
    const { binance, hl } = (() => {
      const serverTsMs = Date.now() - 50;
      const binanceClient = {
        lastPrice: jest.fn().mockResolvedValue(100),
      } as unknown as import('../../stat-arb/feed/binance-public-client').BinancePublicClient;
      const hlClient = {
        l2Snapshot: jest.fn().mockResolvedValue(makeL2Snapshot('XRP', 100_100_000n, 100_200_000n, serverTsMs)),
      } as unknown as import('../reference/hyperliquid-client').HyperliquidClient;
      return { binance: binanceClient, hl: hlClient };
    })();
    const fv = new CrossVenueFairValue(binance, hl);
    const snap = await fv.getBasis('XRP');
    expect(snap.hlBook).toBeDefined();
    expect(snap.hlBook.bids.length).toBe(1);
    expect(snap.hlBook.asks.length).toBe(1);
  });
});
