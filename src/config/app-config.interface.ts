export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  databaseUrl: string;
  databaseUrlApp: string;
  meridianClientKey: string;
  yield: {
    mockEnabled: boolean;
    mockApr: number;
    mockSettleMs: number;
    syncIntervalMs: number;
  };
  ondo: {
    apiBaseUrl: string;
    apiKey: string;
    institutionId: string;
  };
  hedge: {
    mockEnabled: boolean;
    mockFxDriftBpsPerDay: number;
    mockSettleMs: number;
    /** Kill-switch: pause hedging if venue funding exceeds this (basis points). Default 100 bps. */
    maxFundingBps: number;
    /** Kill-switch: pause hedging if the Lira-Bridge exposure feed is older than this (ms). Default 5 min. */
    maxFeedStalenessMs: number;
    /** Fraction of outstanding USDC exposure to hedge. 100 = 100%. Default 100. */
    hedgeRatioPct: number;
    /** Minimum imbalance (as % of target) to trigger a rebalance. Default 5%. */
    rebalanceThresholdPct: number;
    /** How often the hedge monitor cron runs (ms). Default 60s. */
    monitorIntervalMs: number;
    /** 1σ ILS/USD daily vol in basis points — used for 3σ liquidation buffer. Default 94 bps (~5% ann). */
    ilsSigmaBps: number;
    /** How old a cached hedge position can be before re-fetching from the venue (ms). Default 30s. */
    positionStalenessMs: number;
  };
  statArb: {
    /** Use the synthetic feed/venue (offline, deterministic tests). Real venues are armed via LIVE_TRADING_ARMED. */
    mockEnabled: boolean;
    /** Number of synthetic bars per demo backtest run. Default 90. */
    demoBarCount: number;
    /** Symbol A for the demo pair. Default 'BTC'. */
    demoPairA: string;
    /** Symbol B for the demo pair. Default 'ETH'. */
    demoPairB: string;
  };
  execution: {
    /** Execution mode — mock | paper | canary | live. Mock is the default for demo. */
    mode: ExecutionMode;
    /** Percentage of each parent notional sent to the paper leg in canary mode. 0..100. */
    canaryPaperPct: number;
    /** How often the reconciliation cron sweeps. Default 60s. */
    reconciliationIntervalMs: number;
    /**
     * Engineering arm switch for real-money modes. `paper` needs nothing; this
     * gate only fronts `canary`/`live`, where real orders reach a venue. Set
     * LIVE_TRADING_ARMED=true once real venue credentials are wired and a
     * testnet round-trip has passed. Not a business flag — a "this integration
     * is verified" flag.
     */
    liveTradingArmed: boolean;
  };
  /** Market-data source for the live feed + price source. */
  feed: {
    /** 'mock' = synthetic generator; 'binance' = real Binance public REST; 'alpaca' = real Alpaca equities. */
    source: FeedSource;
    /** Public REST base URL. Override for a regional mirror. No key required. */
    binanceBaseUrl: string;
    /** Quote asset the engine trades against (BTC -> BTCUSDT). */
    quote: string;
    /** Kline interval for the live feed. */
    interval: string;
    /** Pyth Benchmarks base URL (TradingView OHLC shim). Public, no key. */
    pythBaseUrl: string;
    /** DefiLlama stablecoins base URL (peg reference). Public, no key. */
    defillamaBaseUrl: string;
    /** Bit2C base URL (Israeli exchange, ILS reference). Public, no key. */
    bit2cBaseUrl: string;
    /** GeckoTerminal base URL (DEX OHLCV discovery). Public, no key. */
    geckoTerminalBaseUrl: string;
  };
  /**
   * Alpaca equities adapter (FEED_SOURCE=alpaca). Real US-equity market data
   * (split/dividend-adjusted bars) + a paper trading venue. Same REST API for
   * paper and live, so EXECUTION_MODE=paper is honest paper trading on real
   * prices. Keys are read once here (the `ondo.apiKey` precedent), never via
   * process.env elsewhere (§6).
   */
  alpaca: {
    /** APCA-API-KEY-ID. Empty until provisioned — the adapter throws if used unkeyed. */
    keyId: string;
    /** APCA-API-SECRET-KEY. */
    secret: string;
    /** Market-data REST base URL. Default https://data.alpaca.markets. */
    dataBaseUrl: string;
    /** Paper-trading REST base URL. Default https://paper-api.alpaca.markets. */
    tradingBaseUrl: string;
    /** Data feed: 'iex' (free tier) or 'sip' (paid, full consolidated tape). Default 'iex'. */
    dataFeed: string;
  };
  /** Live paper-trading loop configuration. */
  live: {
    /** Auto-start the loop on boot when the feed source is real. */
    autoStart: boolean;
    pairA: string;
    pairB: string;
    /** Default strategy catalogue id the live loop builds (see StrategyRegistry). */
    strategyId: string;
    /** Initial hedge ratio (overridden by refit if enabled). */
    beta: number;
    zLookback: number;
    entryZ: number;
    exitZ: number;
    /** Per-leg notional in 6-decimal USDC units. */
    notionalUnits: bigint;
    /** Loop poll cadence (ms). Bars only advance when a new closed bar exists. */
    pollIntervalMs: number;
    /** Block new entries when drawdown exceeds this percent. */
    maxDrawdownPct: number;
    /** Capital anchor for the drawdown NAV ratio (6-dec USDC units). */
    capitalUnits: bigint;
    /** Per-symbol ADV for the paper slippage model (USDC units). 0 = no slippage. */
    advUnits: bigint;
    /** Slippage lambda (bps per notional/ADV). */
    slippageLambdaBps: number;
  };
  /** Automated market-making books (runs alongside the stat-arb portfolio). */
  marketMaking: {
    /** Default quoter catalogue id (mmStrategyRegistry): mm-symmetric | mm-avellaneda-stoikov | mm-glft. */
    defaultStrategyId: string;
    /** Default instrument the MM screen loads. */
    defaultSymbol: string;
    /** Asset units quoted per side (6-dec; 1.0 asset = 1_000_000). */
    quoteSizeUnits: bigint;
    /** Per-book capital anchor (6-dec USDC units). */
    capitalUnits: bigint;
    /** Loop poll cadence (ms). */
    pollIntervalMs: number;
    /** Rolling realised-σ window (bars). */
    volWindowBars: number;
    /** σ floor as a fraction of price, so a flat warmup never yields a zero spread. */
    volFloor: number;
    /** Horizon (bars) for the AS (T−t) inventory term. */
    horizonBars: number;
    /** γ — quoter risk aversion. */
    gamma: number;
    /** κ — quoter order-arrival decay. */
    kappa: number;
    /** Half-spread floor in bps of mid. */
    minHalfSpreadBps: number;
    /** Half-spread cap in bps of mid (safety rail). */
    maxHalfSpreadBps: number;
    /** Saturation cap on |inventory| in lots (one lot = one quote size). */
    maxInventoryLots: number;
    /** Maker fee in bps, SIGNED: negative = rebate (revenue). */
    makerFeeBps: number;
    /** Drawdown kill: deny quoting below this NAV-ratio drawdown (percent). */
    maxDrawdownPct: number;
  };
}

export type FeedSource = 'mock' | 'binance' | 'alpaca';

export type ExecutionMode = 'mock' | 'paper' | 'canary' | 'live';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['mock', 'paper', 'canary', 'live'];
