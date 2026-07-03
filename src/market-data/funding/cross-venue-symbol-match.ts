// Cross-venue symbol matching (PROFIT_PIVOT_II — Journal #92 bug fix).
//
// Different perp/spot venues sometimes list UNRELATED tokens under the same ticker
// (Hyperliquid's perp "LIT" is Lighter, a rival perp-DEX's token; Binance's spot
// "LITUSDT" is Litentry, an unrelated project — confirmed live #92: 177% apart).
// Matching a carry pair's legs by ticker string alone can silently pair two
// different underlyings, turning a "delta-hedged funding carry" book into a naked
// bet between two uncorrelated assets. A genuine same-asset perp/spot pair trades
// within a few percent of each other at all times (that gap IS the basis funding
// exists to bound); a large gap is the mechanical tell that the match is wrong.

/** Result of mapping an HL coin to a Binance USDT spot market. */
export interface SpotMarketMatch {
  /** The Binance spot market symbol (e.g. 'PEPEUSDT'), or null if none exists. */
  market: string | null;
  /** k-prefixed HL coin (e.g. kPEPE) ⇒ the spot leg trades the unprefixed asset at 1000× quantity. */
  scaled: boolean;
}

/** Map an HL coin to its Binance USDT spot market (k-prefix = 1000× wrapper). */
export function spotMarketFor(coin: string, spotPrices: ReadonlyMap<string, number>): SpotMarketMatch {
  const direct = `${coin.toUpperCase()}USDT`;
  if (spotPrices.has(direct)) return { market: direct, scaled: false };
  if (/^k[A-Z]/.test(coin)) {
    const unwrapped = `${coin.slice(1).toUpperCase()}USDT`;
    if (spotPrices.has(unwrapped)) return { market: unwrapped, scaled: true };
  }
  return { market: null, scaled: false };
}

export interface BasisSanity {
  /** True when the perp and spot prices plausibly reference the same underlying. */
  ok: boolean;
  /** Signed (perpPrice/spotPrice − 1) × 100 — NaN if either price is non-positive. */
  basisPct: number;
}

/** Default max |perp/spot − 1|, percent, before two tickers are treated as a mismatch. */
export const DEFAULT_MAX_BASIS_PCT = 5;

/**
 * True when an HL perp mark price and a Binance spot price are close enough to be
 * the same underlying asset. `scaled` accounts for HL's k-prefix 1000× wrapper
 * (kPEPE prices at ~1000× PEPE's spot price) — compare the UN-scaled per-unit price.
 */
export function checkSameUnderlyingBasis(
  perpMarkPx: number,
  spotPx: number,
  scaled: boolean,
  maxBasisPct: number = DEFAULT_MAX_BASIS_PCT,
): BasisSanity {
  if (!(perpMarkPx > 0) || !(spotPx > 0)) return { ok: false, basisPct: NaN };
  const comparablePerpPx = scaled ? perpMarkPx / 1000 : perpMarkPx;
  const basisPct = (comparablePerpPx / spotPx - 1) * 100;
  return { ok: Math.abs(basisPct) <= maxBasisPct, basisPct };
}
