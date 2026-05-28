import { ConfigService } from '@nestjs/config';
import { ExecutionModeBootGuard, ExecutionModeNotPermittedError } from './execution-mode.guard';
import { AppConfig, ExecutionMode } from '@config/app-config.interface';

function cfgService(opts: {
  mode: ExecutionMode;
  kyb?: boolean;
  mockEnabled?: boolean;
}): ConfigService {
  const cfg: Partial<AppConfig> = {
    statArb: { mockEnabled: opts.mockEnabled ?? true, demoBarCount: 90, demoPairA: 'BTC', demoPairB: 'ETH' },
    execution: {
      mode: opts.mode,
      canaryPaperPct: 100,
      reconciliationIntervalMs: 60_000,
      kybConfirmed: opts.kyb ?? false,
    },
  };
  return { getOrThrow: () => cfg } as unknown as ConfigService;
}

describe('ExecutionModeBootGuard', () => {
  it('mock mode boots without KYB', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'mock' }));
    expect(() => g.assert()).not.toThrow();
  });

  it('paper mode boots without KYB', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'paper' }));
    expect(() => g.assert()).not.toThrow();
  });

  it('canary mode refuses to boot without KYB', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'canary', kyb: false }));
    expect(() => g.assert()).toThrow(ExecutionModeNotPermittedError);
  });

  it('canary mode boots when KYB is confirmed', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'canary', kyb: true }));
    expect(() => g.assert()).not.toThrow();
  });

  it('live mode refuses to boot without KYB', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', kyb: false, mockEnabled: false }));
    expect(() => g.assert()).toThrow(ExecutionModeNotPermittedError);
  });

  it('live mode refuses to boot when mock trading is still enabled', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', kyb: true, mockEnabled: true }));
    expect(() => g.assert()).toThrow(/MOCK_TRADING_ENABLED/);
  });

  it('live mode boots when KYB is confirmed AND mock trading is disabled', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', kyb: true, mockEnabled: false }));
    expect(() => g.assert()).not.toThrow();
  });

  it('onApplicationBootstrap delegates to assert', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'mock' }));
    expect(() => g.onApplicationBootstrap()).not.toThrow();
  });
});
