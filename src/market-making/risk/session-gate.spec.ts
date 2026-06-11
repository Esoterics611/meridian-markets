import { parseSessionGate, sessionForSymbol } from './session-gate';

describe('session-gate parser', () => {
  it('parses a single rule with xyz: symbols (exact-case, colons in symbols)', () => {
    const rules = parseSessionGate('xyz:NVDA,xyz:TSLA,xyz:SKHX=1330-2000');
    expect(rules).toHaveLength(1);
    expect(rules[0].symbols).toEqual(['xyz:NVDA', 'xyz:TSLA', 'xyz:SKHX']);
    expect(rules[0].openMin).toBe(13 * 60 + 30);
    expect(rules[0].closeMin).toBe(20 * 60);
  });

  it('parses multiple ;-separated rules', () => {
    const rules = parseSessionGate('xyz:NVDA=1330-2000;xyz:JP225=0000-0600');
    expect(rules).toHaveLength(2);
    expect(sessionForSymbol(rules, 'xyz:JP225')).toEqual({ openMin: 0, closeMin: 360 });
  });

  it('returns undefined for an ungated symbol (quote 24h)', () => {
    const rules = parseSessionGate('xyz:NVDA=1330-2000');
    expect(sessionForSymbol(rules, 'xyz:CL')).toBeUndefined();
    expect(sessionForSymbol(rules, 'FARTCOIN')).toBeUndefined();
  });

  it('skips malformed rules instead of throwing (a typo must not kill boot)', () => {
    expect(parseSessionGate('garbage')).toEqual([]);
    expect(parseSessionGate('xyz:NVDA=2000-1330')).toEqual([]); // inverted window
    expect(parseSessionGate('=1330-2000')).toEqual([]); // no symbols
    expect(parseSessionGate('xyz:NVDA=13302000;xyz:TSLA=1330-2000')).toHaveLength(1);
    expect(parseSessionGate(undefined)).toEqual([]);
    expect(parseSessionGate('')).toEqual([]);
  });
});
