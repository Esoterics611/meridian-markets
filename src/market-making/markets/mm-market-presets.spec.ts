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

  it('ships a DEX preset routed to the geckoterminal reference source', () => {
    const dex = getMmPreset('dex-eth-bluechip');
    expect(dex).toBeDefined();
    expect(dex!.source).toBe('geckoterminal');
    expect(dex!.symbols).toEqual(expect.arrayContaining(['WETHUSDC', 'WBTCWETH']));
    expect(dex!.symbols).toContain(dex!.defaultSymbol);
  });

  it('marks the Binance presets with an explicit binance source (HL is the default venue)', () => {
    // Since marketMaking.defaultSource = 'hyperliquid', a preset that omits `source`
    // would fall back to HL — so the Binance presets pin it explicitly to stay on Binance.
    expect(getMmPreset('stablecoin-peg')!.source).toBe('binance');
    expect(getMmPreset('crypto-majors-mm')!.source).toBe('binance');
    expect(getMmPreset('fx-via-stables')!.source).toBe('binance');
  });

  it('routes the perp preset to Hyperliquid (the default MM venue)', () => {
    expect(getMmPreset('hl-perps')!.source).toBe('hyperliquid');
  });

  it('ships the hl-discovery preset (calm liquid non-major HL perps) routed to Hyperliquid', () => {
    const disc = getMmPreset('hl-discovery');
    expect(disc).toBeDefined();
    expect(disc!.source).toBe('hyperliquid');
    expect(disc!.symbols).toEqual(expect.arrayContaining(['XRP', 'DOGE', 'BNB']));
    expect(disc!.symbols).toContain(disc!.defaultSymbol);
    // Discovery is strictly NON-major — BTC/ETH/SOL live in hl-perps, not here.
    expect(disc!.symbols).not.toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL']));
  });
});
