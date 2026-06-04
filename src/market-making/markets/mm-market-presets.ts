// MM market presets — curated sets of single instruments to run automated
// market-making books on, grouped by asset class. Unlike the stat-arb presets
// (which are symbol *sets* fed to pair discovery), a market-making preset is a
// list of individually-quotable instruments: each becomes its own MM book with
// its own inventory and quotes. Every symbol quotes against a single quote asset
// (USDT) and resolves to a real Binance public-REST market at the venue
// boundary, so these ride the same feed the stat-arb engine already uses — no
// new adapter.
//
// The stablecoin sets are the point of this whole feature: USDC/FDUSD/TUSD/DAI
// vs USDT are pegged ≈1.0, so the bid/ask straddles par and the spread captured
// is the peg's micro-volatility — a low-inventory-risk book that's the natural
// home for AS/GLFT quoting. EUR/EURI vs USDT is the FX-via-stables bridge: the
// quote is the on-chain euro, and the spread you earn is the EUR/USD micro-
// structure (TESSERA §1.3). Crypto majors are included so a desk can A/B the
// same quoter on a high-vol class and watch inventory risk dominate.

export interface MmMarketPreset {
  id: string;
  label: string;
  assetClass: string;
  description: string;
  /** Internal short symbols; each runs as its own MM book. */
  symbols: string[];
  /** The instrument the MM screen loads first. */
  defaultSymbol: string;
  /** Quote asset for the Binance market symbol (unused when `source` is set). */
  quote: string;
  /**
   * Venue/source id for every book in the preset. 'binance' = the native Binance
   * feed; a reference id ('hyperliquid'/'geckoterminal'/…) = a `ReferenceBarFeed`
   * (each symbol is that source's key, `quote` is cosmetic). Omitting it falls back
   * to the desk default venue (`marketMaking.defaultSource` = Hyperliquid), so the
   * Binance presets set it EXPLICITLY to stay on Binance.
   */
  source?: string;
}

export const MM_MARKET_PRESETS: readonly MmMarketPreset[] = [
  {
    id: 'stablecoin-peg',
    label: 'Stablecoin Peg',
    assetClass: 'Stablecoin',
    description:
      'USD-stable vs USDT, all pegged ≈1.0. The spread is pure peg micro-volatility — low inventory risk, the cleanest home for inventory-aware quoting.',
    symbols: ['USDC', 'FDUSD', 'TUSD', 'DAI', 'USD1'],
    defaultSymbol: 'FDUSD',
    quote: 'USDT',
    source: 'binance',
  },
  {
    id: 'fx-via-stables',
    label: 'FX via Stables (EUR)',
    assetClass: 'FX',
    description:
      'EUR-stables vs USDT — the spread is the on-chain EUR/USD microstructure, a 24/7 FX-basis book (TESSERA §1.3).',
    symbols: ['EUR', 'EURI'],
    defaultSymbol: 'EUR',
    quote: 'USDT',
    source: 'binance',
  },
  {
    id: 'crypto-majors-mm',
    label: 'Crypto Majors (high-vol MM)',
    assetClass: 'Large Cap',
    description:
      'BTC/ETH/SOL/BNB vs USDT — a high-vol class to A/B the quoter against the stablecoin book and watch inventory risk dominate.',
    symbols: ['BTC', 'ETH', 'SOL', 'BNB'],
    defaultSymbol: 'SOL',
    quote: 'USDT',
    source: 'binance',
  },
  {
    id: 'dex-eth-bluechip',
    label: 'DEX Bluechip (GeckoTerminal)',
    assetClass: 'DEX',
    description:
      'On-chain Uniswap-v3 pools priced in USD (GeckoTerminal feed) — the discovery frontier: under-watched venues with structurally wider spreads and a ≤0bps maker (LP fees accrue to the maker), the regime the MM book needs (Journal #6/#23). WETH/USDC + WETH/USDT (ETH/USD across fee tiers), WBTC/WETH (BTC/USD), USDC/USDT (peg). Honest caveat: DEX prints are noisier (MEV/thin pools), so the wider spread is hazard-compensation, not free money.',
    symbols: ['WETHUSDC', 'WETHUSDT', 'WBTCWETH', 'USDCUSDT'],
    defaultSymbol: 'WETHUSDC',
    quote: 'USD',
    source: 'geckoterminal',
  },
  {
    id: 'hl-perps',
    label: 'Hyperliquid Perps (CLOB)',
    assetClass: 'Perp DEX',
    description:
      'On-chain perp central limit order book (Hyperliquid) — the maker-REBATE order-book venue the MM engine was built for (−0.2bps maker; Journal #6/#23). Quote BTC/ETH/SOL perps; σ-normalization (S31) makes these high-priced coins quotable. Size by notional (MM_SESSION_QUOTE_USD); the honest book still needs L2 queue-aware fills (next).',
    symbols: ['BTC', 'ETH', 'SOL'],
    defaultSymbol: 'ETH',
    quote: 'USD',
    source: 'hyperliquid',
  },
  {
    id: 'hl-discovery',
    label: 'Hyperliquid Discovery (calm liquid non-majors)',
    assetClass: 'Perp DEX',
    description:
      'Discovery payload from scripts/hl-universe-discovery.ts (2026-06-04, full 230-perp HL scan): the calmest LIQUID non-major HL perps, sitting at major-grade 1m-σ (≈12bps) — the next markets to make markets in beyond BTC/ETH/SOL. XRP stands out (as calm as ETH, $96M/day, funding ≈−19% APR so a forced-short maker earns carry); DOGE/ASTER/BNB are the next calmest. HONEST CAVEAT: ranked by inventory risk on OHLCV proxies, NOT a profitability verdict — the fixed-spread scan nets negative across ALL perps (adverse dominates a tight quote). Capture an L2 tape (mm-l2-session) + γ/κ-tune queue-aware (mm-l2-tune) before sizing. Paper-only.',
    symbols: ['XRP', 'DOGE', 'ASTER', 'BNB'],
    defaultSymbol: 'XRP',
    quote: 'USD',
    source: 'hyperliquid',
  },
];

export function listMmPresets(): readonly MmMarketPreset[] {
  return MM_MARKET_PRESETS;
}

export function getMmPreset(id: string): MmMarketPreset | undefined {
  return MM_MARKET_PRESETS.find((p) => p.id === id);
}
