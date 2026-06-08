import { registerAs } from '@nestjs/config';
import { AppConfig, EXECUTION_MODES, ExecutionMode, FeedSource } from './app-config.interface';

function parseExecutionMode(raw: string | undefined): ExecutionMode {
  if (raw !== undefined && (EXECUTION_MODES as readonly string[]).includes(raw)) {
    return raw as ExecutionMode;
  }
  return 'mock';
}

const FEED_SOURCES: readonly FeedSource[] = ['mock', 'binance', 'alpaca'];

function parseFeedSource(raw: string | undefined): FeedSource {
  return raw !== undefined && (FEED_SOURCES as readonly string[]).includes(raw)
    ? (raw as FeedSource)
    : 'mock';
}

// Sole sanctioned reader of process.env. All other modules consume the typed
// AppConfig via @nestjs/config, or read secrets through ISecretProvider.
export const appConfigFactory = registerAs<AppConfig>('app', (): AppConfig => ({
  nodeEnv: (process.env['NODE_ENV'] as AppConfig['nodeEnv']) ?? 'development',
  port: parseInt(process.env['PORT'] ?? '3100', 10),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  databaseUrlApp: process.env['DATABASE_URL_APP'] ?? '',
  meridianClientKey: process.env['MERIDIAN_CLIENT_KEY'] ?? '',
  yield: {
    mockEnabled: process.env['MOCK_YIELD_ENABLED'] !== 'false',
    mockApr: parseFloat(process.env['MOCK_YIELD_APR'] ?? '0.05'),
    mockSettleMs: parseInt(process.env['MOCK_YIELD_SETTLE_MS'] ?? '250', 10),
    syncIntervalMs: parseInt(process.env['YIELD_SYNC_INTERVAL_MS'] ?? '300000', 10),
  },
  ondo: {
    apiBaseUrl: process.env['ONDO_API_BASE_URL'] ?? '',
    apiKey: process.env['ONDO_API_KEY'] ?? '',
    institutionId: process.env['ONDO_INSTITUTION_ID'] ?? '',
  },
  hedge: {
    mockEnabled: process.env['MOCK_HEDGE_ENABLED'] !== 'false',
    mockFxDriftBpsPerDay: parseFloat(process.env['MOCK_HEDGE_FX_DRIFT_BPS_PER_DAY'] ?? '2'),
    mockSettleMs: parseInt(process.env['MOCK_HEDGE_SETTLE_MS'] ?? '0', 10),
    maxFundingBps: parseInt(process.env['HEDGE_MAX_FUNDING_BPS'] ?? '100', 10),
    maxFeedStalenessMs: parseInt(process.env['HEDGE_MAX_FEED_STALENESS_MS'] ?? '300000', 10),
    hedgeRatioPct: parseInt(process.env['HEDGE_RATIO_PCT'] ?? '100', 10),
    rebalanceThresholdPct: parseInt(process.env['HEDGE_REBALANCE_THRESHOLD_PCT'] ?? '5', 10),
    monitorIntervalMs: parseInt(process.env['HEDGE_MONITOR_INTERVAL_MS'] ?? '60000', 10),
    ilsSigmaBps: parseInt(process.env['HEDGE_ILS_SIGMA_BPS'] ?? '94', 10),
    positionStalenessMs: parseInt(process.env['HEDGE_POSITION_STALENESS_MS'] ?? '30000', 10),
  },
  statArb: {
    mockEnabled: process.env['MOCK_TRADING_ENABLED'] !== 'false',
    demoBarCount: parseInt(process.env['DEMO_BAR_COUNT'] ?? '90', 10),
    demoPairA: process.env['DEMO_PAIR_A'] ?? 'BTC',
    demoPairB: process.env['DEMO_PAIR_B'] ?? 'ETH',
  },
  execution: {
    mode: parseExecutionMode(process.env['EXECUTION_MODE']),
    canaryPaperPct: parseInt(process.env['CANARY_PAPER_PCT'] ?? '100', 10),
    reconciliationIntervalMs: parseInt(process.env['RECONCILIATION_INTERVAL_MS'] ?? '60000', 10),
    liveTradingArmed: process.env['LIVE_TRADING_ARMED'] === 'true',
  },
  feed: {
    source: parseFeedSource(process.env['FEED_SOURCE']),
    binanceBaseUrl: process.env['BINANCE_PUBLIC_BASE_URL'] ?? 'https://api.binance.com',
    quote: process.env['FEED_QUOTE'] ?? 'USDT',
    interval: process.env['FEED_INTERVAL'] ?? '1m',
    pythBaseUrl: process.env['PYTH_BENCHMARKS_BASE_URL'] ?? 'https://benchmarks.pyth.network',
    defillamaBaseUrl: process.env['DEFILLAMA_STABLECOINS_BASE_URL'] ?? 'https://stablecoins.llama.fi',
    bit2cBaseUrl: process.env['BIT2C_BASE_URL'] ?? 'https://bit2c.co.il',
    geckoTerminalBaseUrl:
      process.env['GECKOTERMINAL_BASE_URL'] ?? 'https://api.geckoterminal.com/api/v2',
    hyperliquidBaseUrl: process.env['HYPERLIQUID_BASE_URL'] ?? 'https://api.hyperliquid.xyz',
  },
  alpaca: {
    keyId: process.env['ALPACA_KEY_ID'] ?? '',
    secret: process.env['ALPACA_SECRET'] ?? '',
    dataBaseUrl: process.env['ALPACA_DATA_BASE_URL'] ?? 'https://data.alpaca.markets',
    tradingBaseUrl: process.env['ALPACA_TRADING_BASE_URL'] ?? 'https://paper-api.alpaca.markets',
    dataFeed: process.env['ALPACA_DATA_FEED'] ?? 'iex',
  },
  live: {
    autoStart: process.env['LIVE_AUTOSTART'] === 'true',
    pairA: process.env['LIVE_PAIR_A'] ?? process.env['DEMO_PAIR_A'] ?? 'BTC',
    pairB: process.env['LIVE_PAIR_B'] ?? process.env['DEMO_PAIR_B'] ?? 'ETH',
    strategyId: process.env['LIVE_STRATEGY_ID'] ?? 'pairs-zscore',
    beta: parseFloat(process.env['LIVE_BETA'] ?? '1'),
    zLookback: parseInt(process.env['LIVE_Z_LOOKBACK'] ?? '20', 10),
    entryZ: parseFloat(process.env['LIVE_ENTRY_Z'] ?? '2'),
    exitZ: parseFloat(process.env['LIVE_EXIT_Z'] ?? '0.5'),
    notionalUnits: BigInt(process.env['LIVE_NOTIONAL_UNITS'] ?? '1000000000'), // 1000 USDC
    pollIntervalMs: parseInt(process.env['LIVE_POLL_INTERVAL_MS'] ?? '15000', 10),
    maxDrawdownPct: parseFloat(process.env['LIVE_MAX_DRAWDOWN_PCT'] ?? '10'),
    capitalUnits: BigInt(process.env['LIVE_CAPITAL_UNITS'] ?? '100000000000'), // 100k USDC
    advUnits: BigInt(process.env['LIVE_ADV_UNITS'] ?? '0'), // 0 = slippage off
    slippageLambdaBps: parseFloat(process.env['LIVE_SLIPPAGE_LAMBDA_BPS'] ?? '100'),
    // Restart-safe stat-arb books — off by default (no DB dependency on the live path).
    persist: (process.env['STAT_ARB_PERSIST'] ?? 'false').toLowerCase() === 'true',
    flattenOnShutdown: (process.env['STAT_ARB_FLATTEN_ON_SHUTDOWN'] ?? 'false').toLowerCase() === 'true',
  },
  marketMaking: {
    // Default MM venue = Hyperliquid (the maker-rebate perp CLOB, DATA_SOURCES.md).
    // GLFT is the continuous-book quoter; BTC is a liquid HL perp. The global feed
    // (FEED_SOURCE) stays Binance — HL is perps-only, a per-book source not the spine.
    defaultStrategyId: process.env['MM_STRATEGY_ID'] ?? 'mm-glft',
    defaultSymbol: process.env['MM_SYMBOL'] ?? 'BTC',
    defaultSource: process.env['MM_SOURCE'] ?? 'hyperliquid',
    quoteSizeUnits: BigInt(process.env['MM_QUOTE_SIZE_UNITS'] ?? '1000000000'), // 1000 asset units
    capitalUnits: BigInt(process.env['MM_CAPITAL_UNITS'] ?? '100000000000'), // 100k USDC
    pollIntervalMs: parseInt(process.env['MM_POLL_INTERVAL_MS'] ?? '15000', 10),
    volWindowBars: parseInt(process.env['MM_VOL_WINDOW_BARS'] ?? '30', 10),
    volFloor: parseFloat(process.env['MM_VOL_FLOOR'] ?? '0.0001'),
    horizonBars: parseFloat(process.env['MM_HORIZON_BARS'] ?? '1'),
    gamma: parseFloat(process.env['MM_GAMMA'] ?? '0.0025'),
    kappa: parseFloat(process.env['MM_KAPPA'] ?? '2'),
    minHalfSpreadBps: parseFloat(process.env['MM_MIN_HALF_SPREAD_BPS'] ?? '1'),
    maxHalfSpreadBps: parseFloat(process.env['MM_MAX_HALF_SPREAD_BPS'] ?? '200'),
    maxInventoryLots: parseFloat(process.env['MM_MAX_INVENTORY_LOTS'] ?? '8'),
    // Inventory governor (Journal #39/#41 — inventory carry was the whole loss). The bare A-S
    // skew is ~2 bps at full inventory (negligible); inventorySkewMult scales the skew term
    // so it actually mean-reverts, and hardInventoryCap parks the accumulating side at the
    // rail so the book cannot breach the cap. NOW ON BY DEFAULT (Journal #43): the desk ran with
    // the governor at its legacy no-op and accumulated runaway one-sided inventory (e.g. −1.65M
    // ADA, BTC at 88% of book notional, 10%+ maxDD) whose mark-to-market — not spread — drove
    // net P&L. skewMult=4 is a starting value pending a γ/κ/skew sweep; the hard + notional caps
    // are deterministic bounds, not tuning. Override via env to reproduce the legacy no-op.
    inventorySkewMult: parseFloat(process.env['MM_INVENTORY_SKEW_MULT'] ?? '4'),
    hardInventoryCap: (process.env['MM_HARD_INVENTORY_CAP'] ?? 'true').toLowerCase() === 'true',
    // Notional inventory cap (Journal #41): cap |inventory| at this fraction of book capital at
    // the live mid, so the bound is the same RISK across a 100×-price universe rather than the
    // same lot count (a fixed 8-lot cap let BTC run to 88% of book notional). 0 = off (legacy
    // lot-count cap). Default 0.25 ⇒ no book holds more than a quarter of its capital in inventory.
    maxInventoryNotionalFrac: parseFloat(process.env['MM_MAX_INVENTORY_NOTIONAL_FRAC'] ?? '0.25'),
    // Desk delta hedge (HEDGING_MODEL.md): a paper perp leg offsetting each book's net delta so
    // the desk earns the MM edge (spread+rebate−adverse) without the directional variance that
    // was the #41 loss. Off by default (no hedge venue, trader unchanged). Band in USD.
    deltaHedge: (process.env['MM_DELTA_HEDGE'] ?? 'false').toLowerCase() === 'true',
    hedgeBandUsd: parseFloat(process.env['MM_HEDGE_BAND_USD'] ?? '2000'),
    hedgeTakerBps: parseFloat(process.env['MM_HEDGE_TAKER_BPS'] ?? '2.5'),
    hedgeHalfSpreadBps: parseFloat(process.env['MM_HEDGE_HALF_SPREAD_BPS'] ?? '1'),
    // Screener heuristic only; the LIVE book is priced per-venue via venueFeeFor()
    // (the default-venue HL rebate is −0.2bps). Set MM_MAKER_FEE_BPS to force one.
    makerFeeBps: parseFloat(process.env['MM_MAKER_FEE_BPS'] ?? '-0.2'),
    maxDrawdownPct: parseFloat(process.env['MM_MAX_DRAWDOWN_PCT'] ?? '10'),
    // Restart-safe books: off by default so a no-DB run is unaffected. Turn on for
    // the persistent research system (needs Postgres + migrations).
    persist: (process.env['MM_PERSIST'] ?? 'false').toLowerCase() === 'true',
    flattenOnShutdown: (process.env['MM_FLATTEN_ON_SHUTDOWN'] ?? 'false').toLowerCase() === 'true',
    navIntervalMs: parseInt(process.env['MM_NAV_INTERVAL_MS'] ?? '60000', 10),
    fundingRefreshMs: parseInt(process.env['MM_FUNDING_REFRESH_MS'] ?? '600000', 10), // 10m; HL funds hourly
    microPriceDepth: parseInt(process.env['MM_MICROPRICE_DEPTH'] ?? '5', 10), // F1 quote center off N L2 levels; 0 = off (mid)
    fastRequoteEnabled: (process.env['MM_FAST_REQUOTE_ENABLED'] ?? 'false').toLowerCase() === 'true',
    fastRequoteMs: parseInt(process.env['MM_FAST_REQUOTE_MS'] ?? '750', 10),
    cancelReplaceLatencyMs: parseInt(process.env['MM_CANCEL_REPLACE_LATENCY_MS'] ?? '100', 10),
    fastSymbols: (process.env['MM_FAST_SYMBOLS'] ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fundingBiasSymbols: (process.env['MM_FUNDING_BIAS_SYMBOLS'] ?? 'BTC').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fundingBiasMax: parseFloat(process.env['MM_FUNDING_BIAS_MAX'] ?? '0.39'),
    fundingBiasFullRate: parseFloat(process.env['MM_FUNDING_BIAS_FULL_RATE'] ?? '0.0000125'),
    flowShadow: (process.env['MM_FLOW_SHADOW'] ?? 'false').toLowerCase() === 'true',
    flowFullImbalance: parseFloat(process.env['MM_FLOW_FULL_IMBALANCE'] ?? '0.6'),
    flowMaxBias: parseFloat(process.env['MM_FLOW_MAX_BIAS'] ?? '0.5'),
    flowShadowMinMs: parseInt(process.env['MM_FLOW_SHADOW_MIN_MS'] ?? '1000', 10),
    flowShadowPath: process.env['MM_FLOW_SHADOW_PATH'] ?? '',
    flowBiasLive: (process.env['MM_FLOW_BIAS_LIVE'] ?? 'false').toLowerCase() === 'true',
    flowBiasHorizonMs: parseInt(process.env['MM_FLOW_BIAS_HORIZON_MS'] ?? '60000', 10),
    flowBiasMinIc: parseFloat(process.env['MM_FLOW_BIAS_MIN_IC'] ?? '0.05'),
    dirSpreadSkew: parseFloat(process.env['MM_DIR_SPREAD_SKEW'] ?? '0.5'),
    dirSingleSideBias: parseFloat(process.env['MM_DIR_SINGLE_SIDE_BIAS'] ?? '0.6'),
    // F3 adverse-selection defence: scale the half-spread by trade-flow toxicity vs its
    // rolling average (widen into one-sided/informed sweeps, tighten into calm flow). The
    // same scaler the offline LOB replay validated. Off by default (no-op); on for the run.
    f3Toxicity: (process.env['MM_F3_TOXICITY'] ?? 'false').toLowerCase() === 'true',
    f3MinScale: parseFloat(process.env['MM_F3_MIN_SCALE'] ?? '0.5'),
    f3MaxScale: parseFloat(process.env['MM_F3_MAX_SCALE'] ?? '3.0'),
  },
  telemetry: {
    enabled: (process.env['TELEMETRY_ENABLED'] ?? 'false').toLowerCase() === 'true',
    readyTickMultiplier: parseInt(process.env['TELEMETRY_READY_TICK_MULTIPLIER'] ?? '5', 10),
    feedStalenessMs: parseInt(process.env['TELEMETRY_FEED_STALENESS_MS'] ?? '120000', 10),
  },
}));
