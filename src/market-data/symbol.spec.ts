import { parseSymbol, formatSymbol, isValidSymbol } from './symbol';

describe('parseSymbol', () => {
  it('parses BTC-USDT.spot.binance', () => {
    expect(parseSymbol('BTC-USDT.spot.binance')).toEqual({
      raw: 'BTC-USDT.spot.binance',
      base: 'BTC', quote: 'USDT', kind: 'spot', venue: 'binance',
    });
  });

  it('uppercases base and quote', () => {
    const r = parseSymbol('eth-usdc.spot.binance');
    expect(r.base).toBe('ETH');
    expect(r.quote).toBe('USDC');
    expect(r.raw).toBe('ETH-USDC.spot.binance');
  });

  it('recognises perp and future instrument kinds', () => {
    expect(parseSymbol('BTC-USD.perp.hyperliquid').kind).toBe('perp');
    expect(parseSymbol('BTC-USD.future.deribit').kind).toBe('future');
  });

  it('throws on a malformed symbol', () => {
    expect(() => parseSymbol('BTCUSDT')).toThrow(/malformed/);
    expect(() => parseSymbol('BTC/USDT.spot.binance')).toThrow(/malformed/);
  });

  it('throws on an unknown instrument kind', () => {
    expect(() => parseSymbol('BTC-USDT.exotic.binance')).toThrow(/unknown instrument kind/);
  });

  it('trims surrounding whitespace', () => {
    expect(parseSymbol('  BTC-USDT.spot.binance  ').base).toBe('BTC');
  });

  it('preserves multi-segment venue identifiers', () => {
    expect(parseSymbol('BTC-USDT.spot.binance-us').venue).toBe('binance-us');
  });

  it('rejects empty strings', () => {
    expect(() => parseSymbol('')).toThrow();
  });
});

describe('formatSymbol', () => {
  it('round-trips with parseSymbol', () => {
    const raw = 'BTC-USDT.spot.binance';
    const parsed = parseSymbol(raw);
    expect(formatSymbol(parsed)).toBe(raw);
  });
});

describe('isValidSymbol', () => {
  it('returns true for a parseable symbol', () => {
    expect(isValidSymbol('BTC-USDT.spot.binance')).toBe(true);
  });

  it('returns false for garbage', () => {
    expect(isValidSymbol('not a symbol')).toBe(false);
  });
});
