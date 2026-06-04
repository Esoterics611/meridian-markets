import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AppConfig } from '@config/app-config.interface';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Restart-safe books: lets OnApplicationShutdown hooks fire on SIGINT/SIGTERM so
  // the MM trader flattens (if configured) + checkpoints final P&L before exit.
  app.enableShutdownHooks();
  const cfg = app.get(ConfigService).getOrThrow<AppConfig>('app');
  await app.listen(cfg.port);
  new Logger('Bootstrap').log(`Meridian Markets listening on :${cfg.port}`);
}

void bootstrap();
