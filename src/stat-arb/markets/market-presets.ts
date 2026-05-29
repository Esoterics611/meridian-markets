// Market presets — curated "presaved markets" the demo can switch between, each
// a set of real Binance SPOT symbols grouped by asset class. This is the
// multi-asset surface for the live demo: pick a preset, backfill its symbols
// from real Binance history, run pair discovery over them, trade the result.
//
// Symbols are the engine's internal short form ('BTC'), mapped to Binance
// market symbols at the venue boundary by toBinanceSymbol(). Everything quotes
// against a single quote asset (USDT by default).
//
// Curation rule: only assets priced comfortably above ~$0.10 are included.
// The engine stores prices as 6-decimal micros (CLAUDE.md §3); sub-cent assets
// (SHIB, PEPE) would lose precision under that convention, so they are left out
// until the storage scale is widened.
//
// "Asset class" within Binance public spot is necessarily crypto-flavoured, but
// the buckets are real and tradeable: large caps, L1 smart-contract platforms,
// DeFi blue-chips, the ETH ecosystem, and a payments/store-of-value set that
// includes PAXG (tokenised gold) as a genuine cross-asset proxy.

export interface MarketPreset {
  /** Stable id used in API calls and the UI dropdown. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Asset-class tag shown as a chip. */
  assetClass: string;
  /** One-line description of what co-moves here. */
  description: string;
  /** Internal short symbols. Backfilled + discovered as a set. */
  symbols: string[];
  /** The pair the Trader screen loads first for this preset. */
  defaultPair: [string, string];
  /** Quote asset for the Binance market symbol. */
  quote: string;
}

export const MARKET_PRESETS: readonly MarketPreset[] = [
  {
    id: 'crypto-majors',
    label: 'Crypto — Large Cap',
    assetClass: 'Large Cap',
    description: 'The most liquid majors. Broadly beta to BTC; ETH/BTC is the canonical pair.',
    symbols: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'LTC', 'BCH', 'ADA', 'AVAX', 'LINK'],
    defaultPair: ['ETH', 'BTC'],
    quote: 'USDT',
  },
  {
    id: 'l1-smart-contract',
    label: 'Layer-1 Platforms',
    assetClass: 'Layer 1',
    description: 'Competing smart-contract L1s — tend to share a risk factor and rotate against each other.',
    symbols: ['SOL', 'ADA', 'AVAX', 'NEAR', 'DOT', 'ATOM', 'APT', 'SUI', 'TRX', 'ALGO'],
    defaultPair: ['SOL', 'AVAX'],
    quote: 'USDT',
  },
  {
    id: 'defi-bluechip',
    label: 'DeFi Blue-Chips',
    assetClass: 'DeFi',
    description: 'Governance tokens of the major protocols. High shared beta, frequent dispersion trades.',
    symbols: ['UNI', 'AAVE', 'LINK', 'MKR', 'CRV', 'LDO', 'COMP', 'SNX', 'INJ'],
    defaultPair: ['AAVE', 'UNI'],
    quote: 'USDT',
  },
  {
    id: 'eth-ecosystem',
    label: 'ETH Ecosystem',
    assetClass: 'ETH Beta',
    description: 'L2s and ETH-adjacent tokens that co-move tightly with ETH — clean cointegration candidates.',
    symbols: ['ETH', 'ARB', 'OP', 'MATIC', 'LDO', 'LINK', 'UNI'],
    defaultPair: ['ARB', 'OP'],
    quote: 'USDT',
  },
  {
    id: 'payments-sov',
    label: 'Payments & Store-of-Value',
    assetClass: 'Cross-Asset',
    description: 'Payment coins plus PAXG (tokenised gold) — a real cross-asset set spanning crypto and a commodity proxy.',
    symbols: ['BTC', 'LTC', 'BCH', 'XRP', 'XLM', 'PAXG'],
    defaultPair: ['LTC', 'BCH'],
    quote: 'USDT',
  },
] as const;

export function listPresets(): readonly MarketPreset[] {
  return MARKET_PRESETS;
}

export function getPreset(id: string): MarketPreset | undefined {
  return MARKET_PRESETS.find((p) => p.id === id);
}

/** Resolve a preset id to its symbol set; throws on unknown id (callers validate input). */
export function presetSymbols(id: string): string[] {
  const p = getPreset(id);
  if (!p) throw new Error(`unknown market preset: ${id}`);
  return [...p.symbols];
}
