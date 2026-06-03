import { ScannerPreset } from '../../stat-arb/discovery/opportunity-scanner';

// Scanner presets backed by NON-Binance reference sources. These are kept
// separate from MARKET_PRESETS (which stay Binance-only so backfill / launch /
// discovery dropdowns remain valid) and are appended to the scanner's universe
// only. The live paper trader is Binance-fed today, so opportunities from these
// presets are surfaced as "scan-only" in the UI until a per-source live feed
// lands (tracked as the Phase-3 follow-up).
//
// Pyth FX is the workhorse: the TradingView shim yields real 1-minute OHLC, so
// these FX legs genuinely cointegrate and rank like any crypto pair.

export const REFERENCE_PRESETS: readonly (ScannerPreset & { source: string })[] = [
  {
    id: 'fx-pyth',
    label: 'FX Majors (Pyth)',
    assetClass: 'FX',
    source: 'pyth',
    // USD-crosses co-move through the dollar factor; EUR/GBP/AUD vs USD and the
    // USD/JPY,/CHF,/ILS legs give a real cointegration universe off live FX OHLC.
    symbols: ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'USDILS'],
  },
  {
    id: 'dex-eth-bluechip',
    label: 'DEX Bluechip (GeckoTerminal)',
    assetClass: 'DEX',
    source: 'geckoterminal',
    // On-chain Uniswap-v3 pools (real addresses in the GeckoTerminal client's
    // default pool map). Priced in USD (currency=usd), so the discovery universe
    // is: WETH/USDC and WETH/USDT both ≈ ETH/USD across fee tiers (cross-pool
    // microstructure), WBTC/WETH ≈ BTC/USD (the BTC–ETH cross), USDC/USDT the DEX
    // stable peg — under-watched venues with structurally wider spreads (CLAUDE.md
    // §1). Scan-only today; the MM-on-DEX-feed live path is the next step
    // (MARKET_MAKING.md Frontier).
    symbols: ['WETHUSDC', 'WETHUSDT', 'WBTCWETH', 'USDCUSDT'],
  },
];

export function listReferencePresets(): readonly (ScannerPreset & { source: string })[] {
  return REFERENCE_PRESETS;
}
