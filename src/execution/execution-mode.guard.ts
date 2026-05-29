import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, ExecutionMode } from '@config/app-config.interface';

// ExecutionModeBootGuard — runs at application boot. Verifies EXECUTION_MODE is
// consistent with whether real venue connectivity has been armed:
//
//   mock   → always allowed (synthetic venue, no real traffic)
//   paper  → always allowed (real market DATA, simulated fills, no real orders)
//   canary → LIVE_TRADING_ARMED must be true (a real venue leg receives flow)
//   live   → LIVE_TRADING_ARMED must be true AND the mock venue must be off
//
// This is an ENGINEERING gate, not a business one: arm it once real venue
// credentials are wired and a testnet round-trip has passed. A failure throws
// synchronously during boot, refusing to start. This is the only enforcement
// layer — nothing downstream duplicates the check.

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
    const armed = app.execution.liveTradingArmed;
    const mockTradingEnabled = app.statArb.mockEnabled;

    switch (mode) {
      case 'mock':
      case 'paper':
        // No arming required — paper consumes real data but simulates fills.
        this.logger.log(`EXECUTION_MODE=${mode} — boot guard ok`);
        return;
      case 'canary':
        if (!armed) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=canary requires LIVE_TRADING_ARMED=true. Arm it only after real venue credentials are wired and a testnet round-trip has passed.',
          );
        }
        this.logger.warn('EXECUTION_MODE=canary — partial real-venue traffic will be sent.');
        return;
      case 'live':
        if (!armed) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=live requires LIVE_TRADING_ARMED=true.',
          );
        }
        if (mockTradingEnabled) {
          throw new ExecutionModeNotPermittedError(
            'EXECUTION_MODE=live requires MOCK_TRADING_ENABLED=false. Refusing to boot while the mock venue is still wired in.',
          );
        }
        this.logger.warn('EXECUTION_MODE=live — ALL traffic will go to the real venue.');
        return;
    }
  }
}
