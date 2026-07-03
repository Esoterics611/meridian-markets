import { checkSameUnderlyingBasis, DEFAULT_MAX_BASIS_PCT, isKScaledCoin, spotMarketFor } from './cross-venue-symbol-match';

describe('isKScaledCoin', () => {
  it('recognises the k-prefix 1000x wrapper form', () => {
    expect(isKScaledCoin('kPEPE')).toBe(true);
    expect(isKScaledCoin('kBONK')).toBe(true);
  });

  it('does not confuse uppercase-K tickers or plain coins with the wrapper', () => {
    expect(isKScaledCoin('KAVA')).toBe(false); // uppercase K = a real ticker, not the wrapper
    expect(isKScaledCoin('LIT')).toBe(false);
    expect(isKScaledCoin('k')).toBe(false);
  });
});

describe('spotMarketFor', () => {
  it('maps a plain HL coin to its direct Binance USDT market', () => {
    expect(spotMarketFor('AAVE', new Map([['AAVEUSDT', 87]]))).toEqual({ market: 'AAVEUSDT', scaled: false });
  });

  it('unwraps a k-prefixed HL coin to the unscaled Binance market', () => {
    expect(spotMarketFor('kPEPE', new Map([['PEPEUSDT', 0.00002]]))).toEqual({ market: 'PEPEUSDT', scaled: true });
  });

  it('returns null when no Binance market exists', () => {
    expect(spotMarketFor('GRAM', new Map())).toEqual({ market: null, scaled: false });
  });
});

describe('checkSameUnderlyingBasis — the #92 ticker-collision guard', () => {
  it('passes a genuine same-asset pair whose prices track within the band', () => {
    // real #92 board: AAVE entry perp 87.0675 vs spot 87.1050 (~0.04% apart)
    const r = checkSameUnderlyingBasis(87.0675, 87.105, false);
    expect(r.ok).toBe(true);
    expect(r.basisPct).toBeCloseTo(-0.043, 2);
  });

  it('rejects the #92 LIT collision — HL Lighter perp vs Binance Litentry spot', () => {
    // real #92 board: entry perp mid 2.06175 (Lighter) vs spot mid 0.743 (Litentry)
    const r = checkSameUnderlyingBasis(2.0618, 0.743, false);
    expect(r.ok).toBe(false);
    expect(r.basisPct).toBeGreaterThan(150);
  });

  it('accounts for the k-prefix 1000x wrapper before comparing', () => {
    // kPEPE perp priced at ~1000x spot PEPE is a genuine match, not a mismatch
    const r = checkSameUnderlyingBasis(0.02, 0.0000199, true);
    expect(r.ok).toBe(true);
  });

  it('still catches a genuine mismatch even after applying the k-prefix scale', () => {
    // scaling correction narrows a 1000x-looking gap to the real per-unit price, but
    // if that per-unit price still isn't close to spot, it's still a different asset
    const r = checkSameUnderlyingBasis(20, 5, true); // 20/1000=0.02 vs spot 5 — nowhere close
    expect(r.ok).toBe(false);
  });

  it('is configurable via maxBasisPct', () => {
    const tight = checkSameUnderlyingBasis(105, 100, false, 3);
    const loose = checkSameUnderlyingBasis(105, 100, false, 10);
    expect(tight.ok).toBe(false);
    expect(loose.ok).toBe(true);
  });

  it('rejects a non-positive or missing price outright', () => {
    expect(checkSameUnderlyingBasis(0, 100, false).ok).toBe(false);
    expect(checkSameUnderlyingBasis(100, 0, false).ok).toBe(false);
    expect(checkSameUnderlyingBasis(-5, 100, false).ok).toBe(false);
  });

  it('exports a sane default threshold', () => {
    expect(DEFAULT_MAX_BASIS_PCT).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BASIS_PCT).toBeLessThan(20);
  });
});
