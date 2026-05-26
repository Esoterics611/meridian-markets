import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { TreasuryService } from './treasury.service';

// Polls the yield provider every YIELD_SYNC_INTERVAL_MS and writes a
// YIELD_ACCRUAL movement when the provider reports more yield than the local
// cache knows about. Idempotent per day via the unique index on
// (provider, created_at::date) where direction='YIELD_ACCRUAL'.
//
// Plain setInterval rather than @nestjs/schedule's @Interval because the
// interval is configurable at runtime; @Interval expects a compile-time
// number. Same posture as a Cron — runs in-process, single replica.
@Injectable()
export class YieldSyncCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YieldSyncCron.name);
  private handle: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly treasury: TreasuryService,
  ) {}

  onModuleInit(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive sync explicitly
    const intervalMs = app.yield.syncIntervalMs;
    this.handle = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`yield-sync cron started: every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  async tick(): Promise<void> {
    try {
      const row = await this.treasury.syncYield();
      if (row) {
        this.logger.log(
          `yield accrual booked: ${row.amountUnits.toString()} units (provider=${row.provider})`,
        );
      }
    } catch (err) {
      this.logger.error(`yield-sync failed: ${(err as Error).message}`);
    }
  }
}
