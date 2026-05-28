import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, ExecutionMode } from '@config/app-config.interface';

// ExecutionModeBootGuard — runs at application boot. Verifies the
// EXECUTION_MODE config is consistent with the KYB flag:
//
//   mock   → always allowed (no KYB needed)
//   paper  → always allowed (no real venue traffic)
//   canary → KYB_CONFIRMED must be true (real venue leg will receive flow)
//   live   → KYB_CONFIRMED must be true AND MOCK_TRADING_ENABLED must be false
//
// A failure throws synchronously during boot, refusing to start the process.
// This is the only enforcement layer: nothing downstream (router, venue,
// canary) duplicates this check — same posture as Lira-Bridge's startup
// assertions.

export class ExecutionModeNotPermittedError extends Error {
  constructor(reason: string) {
    super(`ExecutionMode boot guard refused start: ${reason}`);
    this.name = 'ExecutionModeNotPermittedError';
  }
}

@Injectable()
export class ExecutionModeBootGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExecutionModeBootGuard.name);

  constructor(private readonly cfg: ConfigService) {}

  onApplicationBootstrap(): void {
    this.assert();
  }

  /** Pure check — extracted for testability. */
  assert(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const mode: ExecutionMode = app.execution.mode;
    const kyb = app.execution.kybConfirmed;
    const mockTradingEnabled = app.statArb.mockEnabled;

    switch (mode) {
      case 'mock':
      case 'paper':
        // No KYB requirement.
        this.logger.log(`EXECUTION_MODE=${mode} — boot guard ok`);
        return;
      case 'canary':
        if (!kyb) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=canary requires KYB_CONFIRMED=true. Set KYB_CONFIRMED only after onboarding has closed with the chosen venue.',
          );
        }
        this.logger.warn('EXECUTION_MODE=canary — partial real-venue traffic will be sent.');
        return;
      case 'live':
        if (!kyb) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=live requires KYB_CONFIRMED=true.',
          );
        }
        if (mockTradingEnabled) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=live requires MOCK_TRADING_ENABLED=false. Refusing to boot while mock venue is still wired in.',
          );
        }
        this.logger.warn('EXECUTION_MODE=live — ALL traffic will go to the real venue.');
        return;
    }
  }
}
