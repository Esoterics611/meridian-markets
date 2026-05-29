import { registerAs } from '@nestjs/config';
import { AppConfig, EXECUTION_MODES, ExecutionMode } from './app-config.interface';

function parseExecutionMode(raw: string | undefined): ExecutionMode {
  if (raw !== undefined && (EXECUTION_MODES as readonly string[]).includes(raw)) {
    return raw as ExecutionMode;
  }
  return 'mock';
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
    source: process.env['FEED_SOURCE'] === 'binance' ? 'binance' : 'mock',
    binanceBaseUrl: process.env['BINANCE_PUBLIC_BASE_URL'] ?? 'https://api.binance.com',
    quote: process.env['FEED_QUOTE'] ?? 'USDT',
    interval: process.env['FEED_INTERVAL'] ?? '1m',
  },
  live: {
    autoStart: process.env['LIVE_AUTOSTART'] === 'true',
    pairA: process.env['LIVE_PAIR_A'] ?? process.env['DEMO_PAIR_A'] ?? 'BTC',
    pairB: process.env['LIVE_PAIR_B'] ?? process.env['DEMO_PAIR_B'] ?? 'ETH',
    beta: parseFloat(process.env['LIVE_BETA'] ?? '1'),
    zLookback: parseInt(process.env['LIVE_Z_LOOKBACK'] ?? '20', 10),
    entryZ: parseFloat(process.env['LIVE_ENTRY_Z'] ?? '2'),
    exitZ: parseFloat(process.env['LIVE_EXIT_Z'] ?? '0.5'),
    notionalUnits: BigInt(process.env['LIVE_NOTIONAL_UNITS'] ?? '1000000000'), // 1000 USDC
    pollIntervalMs: parseInt(process.env['LIVE_POLL_INTERVAL_MS'] ?? '15000', 10),
  },
}));
