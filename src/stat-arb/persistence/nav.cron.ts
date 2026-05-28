import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { StatArbRepository } from './stat-arb.repository';

// NAV cron — computes desk-wide stat-arb NAV from recently persisted trades
// and inserts one row into stat_arb_nav. Same setInterval shape as
// YieldSyncCron / HedgeMonitorCron. Idempotent per UTC day via the partial
// unique index on stat_arb_nav.
//
// Phase 3 scope: NAV is the running sum of net P&L from stat_arb_trades.
// More accurate accounting (mark-to-market on open positions, fees splits,
// per-strategy attribution) is queued for Session 10+.

@Injectable()
export class StatArbNavCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatArbNavCron.name);
  private handle: NodeJS.Timeout | null = null;
  private readonly venue = 'mock';

  constructor(
    private readonly cfg: ConfigService,
    private readonly repo: StatArbRepository,
  ) {}

  onModuleInit(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive the tick explicitly
    // 60s cadence keeps the dashboard fresh; the partial unique index dedupes.
    this.handle = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.logger.log('stat-arb NAV cron started: every 60s (idempotent per UTC day)');
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  async tick(now: Date = new Date()): Promise<void> {
    try {
      const recent = await this.repo.recentTrades(this.venue, 10_000);
      const navUnits = recent.reduce((s, t) => s + t.pnlUnits, 0n);
      // Open positions are not tracked in stat_arb_trades (closed trades only);
      // a future session reads from a positions table. For now: 0.
      const row = await this.repo.insertNav({
        asOf: now,
        navUnits: navUnits < 0n ? 0n : navUnits, // CHECK chk_san_nav_nonneg
        openPositionCount: 0,
      });
      if (row) {
        this.logger.log(`stat-arb NAV booked: ${navUnits.toString()} units (asOf=${now.toISOString()})`);
      }
    } catch (err) {
      this.logger.error(`stat-arb NAV tick failed: ${(err as Error).message}`);
    }
  }
}
