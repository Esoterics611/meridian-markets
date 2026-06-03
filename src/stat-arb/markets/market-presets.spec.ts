import {
  MARKET_PRESETS,
  EQUITY_PRESETS,
  listPresets,
  listEquityPresets,
  getPreset,
  getAnyPreset,
  presetSymbols,
} from './market-presets';
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

describe('equity-presets', () => {
  it('exposes equity baskets with unique ids, all tagged source=alpaca / quote=USD', () => {
    const ids = EQUITY_PRESETS.map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of EQUITY_PRESETS) {
      expect(p.source).toBe('alpaca');
      expect(p.quote).toBe('USD');
      expect(p.symbols.length).toBeGreaterThanOrEqual(2);
      expect(p.symbols).toContain(p.defaultPair[0]);
      expect(p.symbols).toContain(p.defaultPair[1]);
      expect(p.defaultPair[0]).not.toBe(p.defaultPair[1]);
      expect(new Set(p.symbols).size).toBe(p.symbols.length);
    }
    expect(listEquityPresets()).toBe(EQUITY_PRESETS);
  });

  it('equity ids do NOT leak into the Binance path (getPreset), only getAnyPreset resolves them', () => {
    for (const p of EQUITY_PRESETS) {
      expect(getPreset(p.id)).toBeUndefined(); // Binance scanner/factory never see equities
      expect(getAnyPreset(p.id)?.id).toBe(p.id);
    }
    // getAnyPreset still resolves Binance presets.
    expect(getAnyPreset(MARKET_PRESETS[0].id)?.id).toBe(MARKET_PRESETS[0].id);
    expect(getAnyPreset('nope')).toBeUndefined();
  });

  it('has no id collision between the two catalogs', () => {
    const binanceIds = new Set(MARKET_PRESETS.map((p) => p.id));
    for (const p of EQUITY_PRESETS) expect(binanceIds.has(p.id)).toBe(false);
  });
});
