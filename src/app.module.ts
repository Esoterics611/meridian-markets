import { Module } from '@nestjs/common';
import { ConfigModule } from '@config/config.module';
import { SecretsModule } from '@secrets/secrets.module';
import { DatabaseModule } from '@database/database.module';
import { TreasuryModule } from '@treasury/treasury.module';
import { HedgeModule } from './hedge/hedge.module';
import { StatArbModule } from './stat-arb/stat-arb.module';

@Module({
  imports: [ConfigModule, SecretsModule, DatabaseModule, TreasuryModule, HedgeModule, StatArbModule],
})
export class AppModule {}
