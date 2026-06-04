import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ITelemetry, TELEMETRY } from './telemetry.interface';
import { PrometheusRegistry } from './prometheus-registry';
import { MetricsCollector } from './metrics-collector';

// GET /metrics — Prometheus text exposition (FR-1). On scrape the collector reads
// the live desk snapshot + process stats into the registry (pull model, DC-3),
// then we render. When telemetry is disabled the endpoint still answers (200) with
// a one-line note so a misconfigured scrape target fails loud, not silent.
@Controller()
export class MetricsController {
  constructor(
    @Inject(TELEMETRY) private readonly telemetry: ITelemetry,
    private readonly registry: PrometheusRegistry,
    private readonly collector: MetricsCollector,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    if (!this.telemetry.enabled) return '# telemetry disabled (set TELEMETRY_ENABLED=true)\n';
    this.collector.collect();
    return this.registry.render();
  }
}
