import { HyperliquidTradeStream, hlCoin, parseHyperliquidTrades } from './hyperliquid-trades';
import { MinimalWs, RefWsEvent } from './reference-source.interface';

// As HL actually returns trades over the WS: { channel:'trades', data:[{coin,side,px,sz,time}, ...] }
// side 'B' = aggressive buy (lifted ask), 'A' = aggressive sell (hit bid); px/sz are strings.
const TRADES_FRAME = {
  channel: 'trades',
  data: [
    { coin: 'BTC', side: 'B', px: '66000.0', sz: '2.0', time: 1780504474001 },
    { coin: 'BTC', side: 'A', px: '65990.0', sz: '1.5', time: 1780504474050 },
    { coin: 'BTC', side: 'B', px: '66010.0', sz: '0.5', time: 1780504474090 },
  ],
};

describe('parseHyperliquidTrades', () => {
  it('parses the WS envelope into typed prints (px/sz → micros/units, side mapped)', () => {
    const t = parseHyperliquidTrades(TRADES_FRAME);
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ coin: 'BTC', side: 'B', priceMicros: 66000000000n, sizeUnits: 2000000n, tsMs: 1780504474001 });
    expect(t[1].side).toBe('A');
  });

  it('also accepts a bare array, and drops zero-size / unknown-side / malformed rows', () => {
    const t = parseHyperliquidTrades([
      { coin: 'ETH', side: 'B', px: '1800', sz: '1' },
      { coin: 'ETH', side: 'A', px: '1800', sz: '0' }, // zero size dropped
      { coin: 'ETH', side: 'X', px: '1800', sz: '1' }, // unknown side dropped
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ coin: 'ETH', side: 'B', sizeUnits: 1000000n });
    expect(parseHyperliquidTrades(null)).toEqual([]);
    expect(parseHyperliquidTrades({ channel: 'pong' })).toEqual([]);
  });
});

// A fake WHATWG-style socket: captures listeners + sent frames so a test can drive it offline.
function fakeWs() {
  const listeners: Record<string, ((ev: RefWsEvent) => void)[]> = {};
  const sent: string[] = [];
  let closed = false;
  const ws: MinimalWs = {
    addEventListener: (type, listener) => {
      (listeners[type] ??= []).push(listener);
    },
    send: (data: string) => sent.push(data),
    close: () => {
      closed = true;
    },
  };
  return {
    ws,
    sent,
    isClosed: () => closed,
    open: () => (listeners['open'] ?? []).forEach((f) => f({})),
    message: (data: unknown) => (listeners['message'] ?? []).forEach((f) => f({ data: typeof data === 'string' ? data : JSON.stringify(data) })),
  };
}

describe('HyperliquidTradeStream', () => {
  function makeStream(symbols: string[]) {
    const f = fakeWs();
    const stream = new HyperliquidTradeStream({ wsUrl: 'wss://hl.test/ws', symbols, wsFactory: () => f.ws, heartbeatMs: 0 });
    return { f, stream };
  }

  it('subscribes to trades for each symbol on open', () => {
    const { f } = makeStream(['BTC', 'ETH']);
    f.open();
    expect(f.sent).toContain(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } }));
    expect(f.sent).toContain(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'ETH' } }));
  });

  it('drains real aggressor buy/sell volume + traded extremes, then resets', () => {
    const { f, stream } = makeStream(['BTC']);
    f.open();
    f.message(TRADES_FRAME);
    const flow = stream.drain('btc'); // case-insensitive
    expect(flow.aggressiveBuyUnits).toBe(2500000n); // 2.0 + 0.5
    expect(flow.aggressiveSellUnits).toBe(1500000n); // 1.5
    expect(flow.tradeCount).toBe(3);
    expect(flow.highMicros).toBe(66010000000n);
    expect(flow.lowMicros).toBe(65990000000n);
    // a second drain with no new prints is zero flow (counters reset)
    const again = stream.drain('BTC');
    expect(again).toEqual({ aggressiveBuyUnits: 0n, aggressiveSellUnits: 0n, tradeCount: 0 });
  });

  it('ignores non-trades channels and prints for unsubscribed coins', () => {
    const { f, stream } = makeStream(['BTC']);
    f.open();
    f.message({ channel: 'subscriptionResponse', data: { type: 'trades' } });
    f.message({ channel: 'trades', data: [{ coin: 'ETH', side: 'B', px: '1800', sz: '5' }] }); // not subscribed
    expect(stream.drain('BTC').tradeCount).toBe(0);
  });

  it('close() closes the socket and is idempotent', () => {
    const { f, stream } = makeStream(['BTC']);
    stream.close();
    stream.close();
    expect(f.isClosed()).toBe(true);
  });

  it('hlCoin: upper-cases main-dex coins, exact-cases HIP-3 dex-prefixed coins', () => {
    expect(hlCoin('btc')).toBe('BTC');
    expect(hlCoin(' eth ')).toBe('ETH');
    expect(hlCoin('xyz:GOLD')).toBe('xyz:GOLD');
    expect(hlCoin('XYZ:gold')).toBe('xyz:GOLD');
    expect(hlCoin(' xyz: gold ')).toBe('xyz:GOLD');
  });

  it('hlCoin: preserves the literal lower-case k of HL k-coins, leaves KAVA-style names alone', () => {
    expect(hlCoin('kPEPE')).toBe('kPEPE');
    expect(hlCoin('kpepe')).toBe('kPEPE');
    expect(hlCoin('KAVA')).toBe('KAVA');
  });

  it('subscribes + accumulates HIP-3 dex-prefixed coins under the exact-case key', () => {
    const { f, stream } = makeStream(['XYZ:gold']); // sloppy input case
    f.open();
    expect(f.sent).toContain(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'xyz:GOLD' } }));
    f.message({ channel: 'trades', data: [{ coin: 'xyz:GOLD', side: 'B', px: '4088.7', sz: '2', time: 1 }] });
    expect(stream.drain('xyz:GOLD').aggressiveBuyUnits).toBe(2000000n);
  });
});
