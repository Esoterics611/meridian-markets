import { Module } from '@nestjs/common';
import { ConfigModule } from '@config/config.module';
import { SecretsModule } from '@secrets/secrets.module';
import { DatabaseModule } from '@database/database.module';
import { TreasuryModule } from '@treasury/treasury.module';

@Module({
  imports: [ConfigModule, SecretsModule, DatabaseModule, TreasuryModule],
})
export class AppModule {}
