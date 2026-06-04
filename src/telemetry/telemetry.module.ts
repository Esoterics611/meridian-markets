import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { TELEMETRY } from './telemetry.interface';
import { PrometheusRegistry } from './prometheus-registry';
import { PrometheusTelemetry } from './prometheus-telemetry';
import { NULL_TELEMETRY } from './null-telemetry';
import { MetricsCollector } from './metrics-collector';
import { MetricsController } from './metrics.controller';
import { HealthController } from './health.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MarketMakingModule } from '../market-making/market-making.module';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';

// TelemetryModule — the @Global observability seam (CLAUDE.md §7). It always
// provides a PrometheusRegistry (storage) + a global TELEMETRY token, selected by
// config: PrometheusTelemetry when TELEMETRY_ENABLED, else the no-op NullTelemetry.
// The MetricsCollector + HealthController read the live MM desk via the exported
// MmPortfolioTrader (DC-3: read the ledger, don't duplicate it) — so it imports
// MarketMakingModule. MarketMakingModule consumes TELEMETRY through the GLOBAL
// token (optional), so it never imports this module: the graph stays acyclic.
@Global()
@Module({
  imports: [MarketMakingModule],
  providers: [
    PrometheusRegistry,
    {
      provide: TELEMETRY,
      inject: [ConfigService, PrometheusRegistry],
      useFactory: (cfg: ConfigService, registry: PrometheusRegistry) => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return app.telemetry.enabled ? new PrometheusTelemetry(registry) : NULL_TELEMETRY;
      },
    },
    {
      provide: MetricsCollector,
      inject: [ConfigService, PrometheusRegistry, MmPortfolioTrader],
      useFactory: (cfg: ConfigService, registry: PrometheusRegistry, mm: MmPortfolioTrader) => {
        const app = cfg.getOrThrow<AppConfig>('app');
        return new MetricsCollector(registry, mm, app.telemetry.enabled);
      },
    },
    // Global HTTP request metrics; a passthrough no-op when telemetry is disabled.
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  controllers: [MetricsController, HealthController],
  exports: [TELEMETRY, PrometheusRegistry],
})
export class TelemetryModule {}
