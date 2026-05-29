import { ConfigService } from '@nestjs/config';
import { ExecutionModeBootGuard, ExecutionModeNotPermittedError } from './execution-mode.guard';
import { AppConfig, ExecutionMode } from '@config/app-config.interface';

function cfgService(opts: {
  mode: ExecutionMode;
  armed?: boolean;
  mockEnabled?: boolean;
}): ConfigService {
  const cfg: Partial<AppConfig> = {
    statArb: { mockEnabled: opts.mockEnabled ?? true, demoBarCount: 90, demoPairA: 'BTC', demoPairB: 'ETH' },
    execution: {
      mode: opts.mode,
      canaryPaperPct: 100,
      reconciliationIntervalMs: 60_000,
      liveTradingArmed: opts.armed ?? false,
    },
  };
  return { getOrThrow: () => cfg } as unknown as ConfigService;
}

describe('ExecutionModeBootGuard', () => {
  it('mock mode boots unarmed', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'mock' }));
    expect(() => g.assert()).not.toThrow();
  });

  it('paper mode boots unarmed (real data, simulated fills)', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'paper' }));
    expect(() => g.assert()).not.toThrow();
  });

  it('canary mode refuses to boot unarmed', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'canary', armed: false }));
    expect(() => g.assert()).toThrow(ExecutionModeNotPermittedError);
  });

  it('canary mode boots when armed', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'canary', armed: true }));
    expect(() => g.assert()).not.toThrow();
  });

  it('live mode refuses to boot unarmed', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', armed: false, mockEnabled: false }));
    expect(() => g.assert()).toThrow(ExecutionModeNotPermittedError);
  });

  it('live mode refuses to boot when mock trading is still enabled', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', armed: true, mockEnabled: true }));
    expect(() => g.assert()).toThrow(/MOCK_TRADING_ENABLED/);
  });

  it('live mode boots when armed AND mock trading is disabled', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'live', armed: true, mockEnabled: false }));
    expect(() => g.assert()).not.toThrow();
  });

  it('onApplicationBootstrap delegates to assert', () => {
    const g = new ExecutionModeBootGuard(cfgService({ mode: 'mock' }));
    expect(() => g.onApplicationBootstrap()).not.toThrow();
  });
});
