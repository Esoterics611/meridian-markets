import { Controller, Get, Optional, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AppConfig } from '@config/app-config.interface';
import { DbService } from '@database/db.service';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { assessReadiness } from './readiness';

// GET /health (liveness) + GET /health/ready (readiness) — FR-8. Liveness is "the
// process can answer"; readiness is the assessReadiness() decision: DB reachable
// (under MM_PERSIST), the tick loop fresh, and at least one feed fresh. Readiness
// returns 503 when not ready so an orchestrator stops routing to a stuck process.
@Controller('health')
export class HealthController {
  constructor(
    private readonly cfg: ConfigService,
    private readonly mm: MmPortfolioTrader,
    @Optional() private readonly db?: DbService,
  ) {}

  @Get()
  liveness(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{
    ready: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
    uptimeSeconds: number;
  }> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const persistEnabled = app.marketMaking.persist;

    // DB reachability matters only when persistence is on (else restart-safety
    // doesn't depend on it). A missing DbService (no DatabaseModule) ⇒ unreachable.
    let dbReachable: boolean | null = null;
    if (persistEnabled) dbReachable = this.db ? await this.db.ping() : false;

    const snap = this.mm.snapshot();
    const lastTick = this.mm.lastTickAt();
    const nowMs = Date.now();
    const bookBarAgesMs = snap.books
      .filter((b) => b.running && b.lastBarAt)
      .map((b) => nowMs - new Date(b.lastBarAt as string).getTime());

    const result = assessReadiness({
      persistEnabled,
      dbReachable,
      deskRunning: snap.running,
      bookCount: snap.bookCount,
      lastTickAgeMs: lastTick === null ? null : nowMs - lastTick,
      pollIntervalMs: this.mm.getPollIntervalMs(),
      readyTickMultiplier: app.telemetry.readyTickMultiplier,
      bookBarAgesMs,
      feedStalenessMs: app.telemetry.feedStalenessMs,
    });

    res.statusCode = result.ready ? 200 : 503;
    return { ready: result.ready, checks: result.checks, uptimeSeconds: Math.round(process.uptime()) };
  }
}
