import { Module } from '@nestjs/common';
import { ExecutionModeBootGuard } from './execution-mode.guard';
import { ReconciliationCron } from './reconciliation.cron';

// ExecutionModule — owns the boot guard and reconciliation cron. The exec
// algos (TWAP / VWAP / POV / iceberg), routers, and PaperVenue are not
// providers — they're plain classes consumed by the demo and (eventually)
// the strategy runner. Keeping them out of DI keeps the test surface small
// and the swap seam in StatArbModule unchanged.

@Module({
  providers: [ExecutionModeBootGuard, ReconciliationCron],
  exports: [ReconciliationCron],
})
export class ExecutionModule {}
