import { Module } from '@nestjs/common';
import { ConfigModule } from '@config/config.module';
import { SecretsModule } from '@secrets/secrets.module';
import { DatabaseModule } from '@database/database.module';
import { TreasuryModule } from '@treasury/treasury.module';
import { StatArbModule } from './stat-arb/stat-arb.module';
import { MarketDataModule } from './market-data/market-data.module';
import { ExecutionModule } from './execution/execution.module';
import { MarketMakingModule } from './market-making/market-making.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UiModule } from './ui/ui.module';

// The role launcher now owns `/` (LandingController in UiModule, UI_ARCHITECTURE.md
// §3) — the old AppController root→/demo redirect is retired.
@Module({
  imports: [
    ConfigModule, SecretsModule, DatabaseModule,
    TreasuryModule, StatArbModule, MarketDataModule, ExecutionModule,
    MarketMakingModule, TelemetryModule, UiModule,
  ],
})
export class AppModule {}
