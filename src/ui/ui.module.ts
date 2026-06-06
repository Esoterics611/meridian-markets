import { Module } from '@nestjs/common';
import { MarketMakingModule } from '../market-making/market-making.module';
import { ExecController } from './exec.controller';
import { OpsController } from './ops.controller';
import { MmDeskController } from './mm-desk.controller';
import { UiAssetController } from './ui-asset.controller';

// UiModule — the role-scoped, server-rendered UI (docs/UI_ARCHITECTURE.md). It
// owns the new /<role> pages + their SSE streams + the shared static assets, and
// is a *thin read-only view* (CLAUDE.md §1): it injects the live engine services
// (here MmPortfolioTrader, exported by MarketMakingModule) and renders them — it
// adds no providers/state of its own. New role pages slot in as additional
// controllers here, importing whatever engine module exports their data source.
@Module({
  imports: [MarketMakingModule],
  controllers: [ExecController, OpsController, MmDeskController, UiAssetController],
})
export class UiModule {}
