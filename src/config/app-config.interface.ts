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
}
