import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '@config/app-config.interface';
import { DbService } from './db.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const app = cfg.getOrThrow<AppConfig>('app');
        // The running service connects as meridian_markets_app — the role
        // with NO UPDATE/DELETE on treasury_movements. Migrations are run
        // separately via the privileged DATABASE_URL (see database/data-source.ts).
        const url = app.databaseUrlApp || app.databaseUrl;
        return {
          type: 'postgres',
          url,
          synchronize: false,
          autoLoadEntities: false,
          entities: [],
          logging: app.nodeEnv !== 'production' && app.nodeEnv !== 'test',
        };
      },
    }),
  ],
  providers: [DbService],
  exports: [DbService, TypeOrmModule],
})
export class DatabaseModule {}
