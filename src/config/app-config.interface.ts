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
    /** 'mock' = synthetic generator; 'binance' = real Binance public REST. */
    source: 'mock' | 'binance';
    /** Public REST base URL. Override for a regional mirror. No key required. */
    binanceBaseUrl: string;
    /** Quote asset the engine trades against (BTC -> BTCUSDT). */
    quote: string;
    /** Kline interval for the live feed. */
    interval: string;
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
}

export type FeedSource = 'mock' | 'binance';

export type ExecutionMode = 'mock' | 'paper' | 'canary' | 'live';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['mock', 'paper', 'canary', 'live'];
