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
  /**
   * Data source. Omitted/`'binance'` = Binance public spot (the default for
   * MARKET_PRESETS). `'alpaca'` = US equities via the Alpaca adapter — these
   * live in EQUITY_PRESETS, NOT MARKET_PRESETS, so the Binance scanner/factory
   * never try to fetch a ticker like JPM as a Binance market symbol.
   */
  source?: 'binance' | 'alpaca';
}

export const MARKET_PRESETS: readonly MarketPreset[] = [
  {
    id: 'stablecoin-peg',
    label: 'Stablecoin Peg',
    assetClass: 'Stablecoin',
    description:
      'USD-stables quoted vs USDT — all pegged ≈1.0, so a cointegrated pair is a pure peg-basis (credit/liquidity) spread. Pairs with the automated MM books on the same class.',
    symbols: ['USDC', 'FDUSD', 'TUSD', 'DAI', 'USD1'],
    defaultPair: ['USDC', 'FDUSD'],
    quote: 'USDT',
  },
  {
    id: 'fx-stables',
    label: 'FX — EUR Stables',
    assetClass: 'FX',
    description:
      'Euro-denominated stablecoins quoted vs USDT — a cointegrated EUR-stable pair is the on-chain EUR/USD basis (TESSERA §1.3). Pairs with the FX maker books on the same class.',
    symbols: ['EUR', 'EURI'],
    defaultPair: ['EUR', 'EURI'],
    quote: 'USDT',
  },
  {
    id: 'crypto-majors',
    label: 'Crypto — Large Cap',
    assetClass: 'Large Cap',
    description: 'The most liquid majors. Broadly beta to BTC; ETH/BTC is the canonical pair.',
    symbols: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'LTC', 'BCH', 'ADA', 'AVAX', 'LINK', 'DOT', 'TRX', 'DOGE', 'ATOM'],
    defaultPair: ['ETH', 'BTC'],
    quote: 'USDT',
  },
  {
    id: 'l1-smart-contract',
    label: 'Layer-1 Platforms',
    assetClass: 'Layer 1',
    description: 'Competing smart-contract L1s — tend to share a risk factor and rotate against each other.',
    symbols: ['SOL', 'ADA', 'AVAX', 'NEAR', 'DOT', 'ATOM', 'APT', 'SUI', 'TRX', 'ALGO', 'EGLD', 'TIA', 'SEI', 'INJ'],
    defaultPair: ['SOL', 'AVAX'],
    quote: 'USDT',
  },
  {
    id: 'defi-bluechip',
    label: 'DeFi Blue-Chips',
    assetClass: 'DeFi',
    description: 'Governance tokens of the major protocols. High shared beta, frequent dispersion trades.',
    symbols: ['UNI', 'AAVE', 'LINK', 'MKR', 'CRV', 'LDO', 'COMP', 'SNX', 'INJ', 'SUSHI', '1INCH', 'DYDX', 'PENDLE', 'GMX'],
    defaultPair: ['AAVE', 'UNI'],
    quote: 'USDT',
  },
  {
    id: 'eth-ecosystem',
    label: 'ETH Ecosystem',
    assetClass: 'ETH Beta',
    description: 'L2s and ETH-adjacent tokens that co-move tightly with ETH — clean cointegration candidates.',
    symbols: ['ETH', 'ARB', 'OP', 'POL', 'LDO', 'LINK', 'UNI', 'IMX', 'STRK', 'MANTA'],
    defaultPair: ['ARB', 'OP'],
    quote: 'USDT',
  },
  {
    id: 'payments-sov',
    label: 'Payments & Store-of-Value',
    assetClass: 'Cross-Asset',
    description: 'Payment coins plus PAXG (tokenised gold) — a real cross-asset set spanning crypto and a commodity proxy.',
    symbols: ['BTC', 'LTC', 'BCH', 'XRP', 'XLM', 'PAXG', 'DOGE', 'TRX'],
    defaultPair: ['LTC', 'BCH'],
    quote: 'USDT',
  },
  {
    id: 'ai-data',
    label: 'AI & Data',
    assetClass: 'AI',
    description: 'AI / compute / data-network tokens — a young high-beta sector that rotates hard against itself.',
    symbols: ['FET', 'GRT', 'WLD', 'AR', 'TAO', 'THETA', 'NEAR', 'INJ', 'RENDER'],
    defaultPair: ['FET', 'GRT'],
    quote: 'USDT',
  },
  {
    id: 'gaming-meta',
    label: 'Gaming & Metaverse',
    assetClass: 'Gaming',
    description: 'Game / metaverse tokens that co-move on the same risk-on flows — frequent dispersion trades.',
    symbols: ['SAND', 'MANA', 'AXS', 'IMX', 'APE', 'ENJ', 'FLOW', 'GMT'],
    defaultPair: ['SAND', 'MANA'],
    quote: 'USDT',
  },
] as const;

// Equity stat-arb baskets (Alpaca, quote=USD). Curated for GENUINE, structural
// cointegration — same-sector names share cash-flow drivers, so the spread
// mean-reverts by construction. This is the property crypto lacked (Journal #5:
// the "cointegration cliff" — short-window crypto cointegration collapses
// 30→180d). The thesis test is scripts/cointegration-stability.ts STAB_SOURCE=
// alpaca: do these HOLD across 90/180d where crypto went to 0?
//
// Kept SEPARATE from MARKET_PRESETS on purpose: the Binance scanner + live
// factory iterate MARKET_PRESETS and would try to fetch 'JPMUSDT' klines. The
// Alpaca path resolves these explicitly (the stability script + the Alpaca
// branch of the live factory).
export const EQUITY_PRESETS: readonly MarketPreset[] = [
  {
    id: 'equity-banks',
    label: 'US Money-Center & Regional Banks',
    assetClass: 'Financials',
    description: 'Banks share the rate/credit cycle as a common cash-flow driver — dispersion mean-reverts within the group.',
    symbols: ['JPM', 'BAC', 'WFC', 'C', 'USB', 'PNC', 'TFC', 'GS', 'MS'],
    defaultPair: ['JPM', 'BAC'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-energy',
    label: 'Integrated Oil & Refiners',
    assetClass: 'Energy',
    description: 'Crude/crack-spread exposure is the shared factor across majors and refiners — classic intra-sector pairs.',
    symbols: ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'VLO', 'MPC'],
    defaultPair: ['XOM', 'CVX'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-rails',
    label: 'Class-I Railroads',
    assetClass: 'Industrials',
    description: 'A near-duopoly of freight rails on shared volumes/fuel — the textbook structurally-cointegrated group.',
    symbols: ['UNP', 'CSX', 'NSC', 'CP', 'CNI'],
    defaultPair: ['UNP', 'CSX'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-megacap-tech',
    label: 'Mega-Cap Tech',
    assetClass: 'Technology',
    description: 'The mega-cap complex co-moves on rates/AI-capex; rich dispersion but less structural than single-sub-industry groups.',
    symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA'],
    defaultPair: ['AAPL', 'MSFT'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-payments',
    label: 'Card Networks & Payments',
    assetClass: 'Financials',
    description: 'Card-network duopoly + processors share consumer-spend volume — V/MA is a canonical tight pair.',
    symbols: ['V', 'MA', 'AXP', 'PYPL', 'FIS', 'GPN'],
    defaultPair: ['V', 'MA'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-staples',
    label: 'Consumer Staples',
    assetClass: 'Staples',
    description: 'Defensive staples share input-cost/consumer-demand drivers — KO/PEP is the textbook cointegrated pair.',
    symbols: ['KO', 'PEP', 'PG', 'CL', 'MDLZ', 'KMB'],
    defaultPair: ['KO', 'PEP'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-pharma',
    label: 'Big Pharma',
    assetClass: 'Healthcare',
    description: 'Large-cap pharma share regulatory/patent-cycle and defensive-demand factors.',
    symbols: ['PFE', 'MRK', 'BMY', 'ABBV', 'LLY', 'JNJ'],
    defaultPair: ['MRK', 'PFE'],
    quote: 'USD',
    source: 'alpaca',
  },
  {
    id: 'equity-semis',
    label: 'Semiconductors',
    assetClass: 'Technology',
    description: 'Semis ride the same capex/inventory cycle — high shared beta, frequent dispersion (watch idiosyncratic AI-mix).',
    symbols: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'TXN', 'MU'],
    defaultPair: ['NVDA', 'AMD'],
    quote: 'USD',
    source: 'alpaca',
  },
] as const;

export function listPresets(): readonly MarketPreset[] {
  return MARKET_PRESETS;
}

export function listEquityPresets(): readonly MarketPreset[] {
  return EQUITY_PRESETS;
}

export function getPreset(id: string): MarketPreset | undefined {
  return MARKET_PRESETS.find((p) => p.id === id);
}

/**
 * Resolve a preset id across BOTH the Binance catalog and the equity catalog.
 * Used by source-agnostic tools (the cointegration-stability script) that may
 * be pointed at either universe.
 */
export function getAnyPreset(id: string): MarketPreset | undefined {
  return MARKET_PRESETS.find((p) => p.id === id) ?? EQUITY_PRESETS.find((p) => p.id === id);
}

/** Resolve a preset id to its symbol set; throws on unknown id (callers validate input). */
export function presetSymbols(id: string): string[] {
  const p = getPreset(id);
  if (!p) throw new Error(`unknown market preset: ${id}`);
  return [...p.symbols];
}
