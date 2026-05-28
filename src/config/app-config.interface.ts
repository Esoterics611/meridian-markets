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
    /** Mock-default execution venue for the Phase 3 demo. KYB-gated for real venues. */
    mockEnabled: boolean;
    /** Number of synthetic bars per demo backtest run. Default 90. */
    demoBarCount: number;
    /** Symbol A for the demo pair. Default 'BTC'. */
    demoPairA: string;
    /** Symbol B for the demo pair. Default 'ETH'. */
    demoPairB: string;
  };
}
