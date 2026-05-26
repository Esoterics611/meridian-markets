import { Module } from '@nestjs/common';
import { YieldModule } from '@yield/yield.module';
import { TreasuryClientGuard } from './treasury-client.guard';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { YieldSyncCron } from './yield-sync.cron';

@Module({
  imports: [YieldModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, TreasuryClientGuard, YieldSyncCron],
  exports: [TreasuryService],
})
export class TreasuryModule {}
