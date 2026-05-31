import { listMmPresets, getMmPreset, MM_MARKET_PRESETS } from './mm-market-presets';

describe('MM market presets', () => {
  it('ships a stablecoin-peg preset whose default symbol is in its symbol set', () => {
    const peg = getMmPreset('stablecoin-peg');
    expect(peg).toBeDefined();
    expect(peg!.symbols).toEqual(expect.arrayContaining(['USDC', 'FDUSD']));
    expect(peg!.symbols).toContain(peg!.defaultSymbol);
    expect(peg!.quote).toBe('USDT');
  });

  it('lists every preset with a non-empty symbol set and unique ids', () => {
    const presets = listMmPresets();
    expect(presets.length).toBe(MM_MARKET_PRESETS.length);
    const ids = new Set(presets.map((p) => p.id));
    expect(ids.size).toBe(presets.length);
    for (const p of presets) expect(p.symbols.length).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown id', () => {
    expect(getMmPreset('nope')).toBeUndefined();
  });
});
