import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AlertEvent, ITelemetry, MetricLabels } from './telemetry.interface';
import { PrometheusRegistry } from './prometheus-registry';
import { EventLoopMonitor } from './event-loop-monitor';
import { M, METRIC_CATALOG } from './metric-catalog';

// PrometheusTelemetry — the real ITelemetry, writing into a PrometheusRegistry that
// `GET /metrics` renders. On construction it registers the WHOLE §4 catalog so the
// scrape always advertises every metric's HELP/TYPE (even before first use). Each
// emit method looks the metric up by name and updates it; an unknown name or any
// error is swallowed and counted in `meridian_telemetry_errors_total` — telemetry
// never throws into a tick (DC-5).
//
// Event-loop lag is sampled by a self-managed, unref'd timer started on boot and
// cleared on module destroy (no leaked handles). Alerts map to a counter + a
// structured warn/error log (FR-10); richer delivery is a later phase.
export class PrometheusTelemetry implements ITelemetry, OnApplicationBootstrap, OnModuleDestroy {
  readonly enabled = true;
  private readonly logger = new Logger('Telemetry');
  private readonly loopMonitor: EventLoopMonitor;

  constructor(readonly registry: PrometheusRegistry) {
    for (const def of METRIC_CATALOG) {
      if (def.type === 'counter') registry.registerCounter(def.name, def.help);
      else if (def.type === 'gauge') registry.registerGauge(def.name, def.help);
      else registry.registerHistogram(def.name, def.help, def.buckets ?? []);
    }
    this.loopMonitor = new EventLoopMonitor((s) => this.gauge(M.eventLoopLag, s));
  }

  onApplicationBootstrap(): void {
    this.loopMonitor.start();
  }

  onModuleDestroy(): void {
    this.loopMonitor.stop();
  }

  counter(name: string, labels: MetricLabels = {}, delta = 1): void {
    try {
      this.registry.counter(name)?.inc(labels, delta);
    } catch {
      this.swallow();
    }
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    try {
      this.registry.gauge(name)?.set(labels, value);
    } catch {
      this.swallow();
    }
  }

  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    try {
      this.registry.histogram(name)?.observe(labels, value);
    } catch {
      this.swallow();
    }
  }

  alert(event: AlertEvent): void {
    try {
      const severity = event.severity ?? 'warn';
      this.registry.counter(M.alerts)?.inc({ kind: event.kind, severity }, 1);
      const ctx = [event.book && `book=${event.book}`, event.source && `source=${event.source}`].filter(Boolean).join(' ');
      const line = `[alert ${event.kind}] ${event.message}${ctx ? ` (${ctx})` : ''}`;
      if (severity === 'critical') this.logger.error(line);
      else if (severity === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    } catch {
      this.swallow();
    }
  }

  /** Best-effort: an emit that throws is counted, never re-thrown. */
  private swallow(): void {
    try {
      this.registry.counter(M.telemetryErrors)?.inc();
    } catch {
      /* truly nothing more we can do */
    }
  }
}
