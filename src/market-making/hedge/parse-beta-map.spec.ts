import { parseHedgeBetaMap, describeBetaMap } from './parse-beta-map';

describe('parseHedgeBetaMap', () => {
  it('returns {} for an empty/blank string (the explicit self-hedge default)', () => {
    expect(parseHedgeBetaMap('')).toEqual({});
    expect(parseHedgeBetaMap('   ')).toEqual({});
  });

  it('parses SYMBOL:UNDERLYING:BETA triples and upper-cases symbols', () => {
    expect(parseHedgeBetaMap('sol:btc:1.4, eth:BTC:1.2')).toEqual({
      SOL: { underlying: 'BTC', beta: 1.4 },
      ETH: { underlying: 'BTC', beta: 1.2 },
    });
  });

  it('skips malformed entries and warns, keeping the good ones', () => {
    const warns: string[] = [];
    const map = parseHedgeBetaMap('SOL:BTC:1.4,BAD,ETH:BTC:notnum,XRP:BTC:0,DOGE:BTC:1.6', (m) => warns.push(m));
    expect(map).toEqual({
      SOL: { underlying: 'BTC', beta: 1.4 },
      DOGE: { underlying: 'BTC', beta: 1.6 },
    });
    // BAD (no triple), ETH (non-numeric beta), XRP (beta 0 not > 0) all skipped.
    expect(warns).toHaveLength(3);
  });

  it('describeBetaMap renders self-hedge vs an explicit map', () => {
    expect(describeBetaMap({})).toBe('self-hedge per-symbol (beta 1)');
    expect(describeBetaMap({ SOL: { underlying: 'BTC', beta: 1.4 } })).toBe('SOL→BTC×1.4');
  });
});
