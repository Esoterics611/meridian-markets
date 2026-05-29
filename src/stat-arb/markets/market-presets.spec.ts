import { MARKET_PRESETS, listPresets, getPreset, presetSymbols } from './market-presets';
import { toBinanceSymbol } from '../feed/binance-symbol';

describe('market-presets', () => {
  it('exposes a non-empty catalog with unique ids', () => {
    const ids = MARKET_PRESETS.map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset has at least two symbols and a defaultPair drawn from them', () => {
    for (const p of MARKET_PRESETS) {
      expect(p.symbols.length).toBeGreaterThanOrEqual(2);
      expect(p.symbols).toContain(p.defaultPair[0]);
      expect(p.symbols).toContain(p.defaultPair[1]);
      expect(p.defaultPair[0]).not.toBe(p.defaultPair[1]);
    }
  });

  it('symbols within a preset are unique', () => {
    for (const p of MARKET_PRESETS) {
      expect(new Set(p.symbols).size).toBe(p.symbols.length);
    }
  });

  it('every symbol maps to a plausible Binance market symbol', () => {
    for (const p of MARKET_PRESETS) {
      for (const s of p.symbols) {
        expect(toBinanceSymbol(s, p.quote)).toBe(`${s}${p.quote}`);
      }
    }
  });

  it('getPreset / presetSymbols resolve known ids and reject unknown', () => {
    const first = MARKET_PRESETS[0];
    expect(getPreset(first.id)?.id).toBe(first.id);
    expect(presetSymbols(first.id)).toEqual(first.symbols);
    expect(getPreset('nope')).toBeUndefined();
    expect(() => presetSymbols('nope')).toThrow(/unknown market preset/);
  });

  it('listPresets returns the catalog', () => {
    expect(listPresets()).toBe(MARKET_PRESETS);
  });
});
