import { registerAs } from '@nestjs/config';
import { AppConfig } from './app-config.interface';

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
  },
}));
