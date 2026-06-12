import { parseHedgeBetaMap, describeBetaMap, parseHedgeBasisGate, parseHedgeBandMap } from './parse-beta-map';

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
    const map = parseHedgeBetaMap('SOL:BTC:1.4,BAD,ETH:BTC:notnum,XRP:BTC:-1,DOGE:BTC:1.6', (m) => warns.push(m));
    expect(map).toEqual({
      SOL: { underlying: 'BTC', beta: 1.4 },
      DOGE: { underlying: 'BTC', beta: 1.6 },
    });
    // BAD (no triple), ETH (non-numeric beta), XRP (negative beta) all skipped.
    expect(warns).toHaveLength(3);
  });

  it('beta 0 is the explicit do-not-hedge marker, not malformed', () => {
    const warns: string[] = [];
    expect(parseHedgeBetaMap('XRP:BTC:0', (m) => warns.push(m))).toEqual({
      XRP: { underlying: 'BTC', beta: 0 },
    });
    expect(warns).toHaveLength(0);
  });

  it('parses HIP-3 symbols (dex prefix contains the separator) right-anchored, exact-case', () => {
    expect(parseHedgeBetaMap('xyz:GOLD:GOLD:0, XYZ:silver:SILVER:0, SOL:btc:1.4')).toEqual({
      'xyz:GOLD': { underlying: 'GOLD', beta: 0 },
      'xyz:SILVER': { underlying: 'SILVER', beta: 0 },
      SOL: { underlying: 'BTC', beta: 1.4 },
    });
  });

  it('describeBetaMap renders self-hedge vs an explicit map', () => {
    expect(describeBetaMap({})).toBe('self-hedge per-symbol (beta 1)');
    expect(describeBetaMap({ SOL: { underlying: 'BTC', beta: 1.4 } })).toBe('SOL→BTC×1.4');
  });
});

describe('parseHedgeBasisGate (F1)', () => {
  it('parses SYMBOL:POLICY pairs, right-anchored for HIP-3 symbols', () => {
    expect(parseHedgeBasisGate('FARTCOIN:flatten,kPEPE:flatten,xyz:CL:hedge')).toEqual({
      FARTCOIN: 'flatten',
      kPEPE: 'flatten',
      'xyz:CL': 'hedge',
    });
  });

  it('skips malformed entries with a warning; blank ⇒ {}', () => {
    const warns: string[] = [];
    expect(parseHedgeBasisGate('SOL:maybe,:flatten,DOGE:hedge', (m: string) => warns.push(m))).toEqual({ DOGE: 'hedge' });
    expect(warns).toHaveLength(2);
    expect(parseHedgeBasisGate('')).toEqual({});
  });

  it('parseHedgeBandMap: UNDERLYING:USD pairs, malformed skipped', () => {
    const warns: string[] = [];
    expect(parseHedgeBandMap('ETH:3000,xyz:BRENTOIL:5000,BTC:abc', (m: string) => warns.push(m))).toEqual({
      ETH: 3000,
      'xyz:BRENTOIL': 5000,
    });
    expect(warns).toHaveLength(1);
  });
});
