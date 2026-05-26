import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { appConfigFactory } from './app-config.factory';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [appConfigFactory],
      envFilePath: '.env',
    }),
  ],
})
export class ConfigModule {}
