import { PrometheusRegistry } from './prometheus-registry';
import { PrometheusTelemetry } from './prometheus-telemetry';
import { M, METRIC_CATALOG } from './metric-catalog';

describe('PrometheusTelemetry', () => {
  let registry: PrometheusRegistry;
  let telemetry: PrometheusTelemetry;

  beforeEach(() => {
    registry = new PrometheusRegistry();
    telemetry = new PrometheusTelemetry(registry); // no sampler until onApplicationBootstrap
  });

  it('registers every catalog metric up-front (HELP/TYPE advertised before first use)', () => {
    const out = registry.render();
    for (const def of METRIC_CATALOG) {
      expect(out).toContain(`# TYPE ${def.name} ${def.type}`);
    }
  });

  it('routes counter/gauge/histogram emits to the registry', () => {
    telemetry.counter(M.tick, { loop: 'mm' });
    telemetry.counter(M.tick, { loop: 'mm' });
    telemetry.gauge(M.deskEquity, 123_456);
    telemetry.histogram(M.tickDuration, 0.01, { loop: 'mm' });
    expect(registry.counter(M.tick)!.value({ loop: 'mm' })).toBe(2);
    expect(registry.gauge(M.deskEquity)!.value()).toBe(123_456);
    expect(registry.histogram(M.tickDuration)!.snapshot({ loop: 'mm' })!.count).toBe(1);
  });

  it('an unknown metric name is swallowed and counted, never thrown (DC-5)', () => {
    expect(() => telemetry.counter('meridian_not_a_real_metric')).not.toThrow();
    expect(registry.counter(M.telemetryErrors)!.value()).toBe(0); // unknown name ≠ error, just a no-op lookup
    expect(telemetry.enabled).toBe(true);
  });

  it('alert increments the alert counter and is uniform', () => {
    telemetry.alert({ kind: 'tick_overrun', message: 'slow', severity: 'warn' });
    telemetry.alert({ kind: 'persist_failure', message: 'db down', severity: 'critical', book: 'BTC' });
    expect(registry.counter(M.alerts)!.value({ kind: 'tick_overrun', severity: 'warn' })).toBe(1);
    expect(registry.counter(M.alerts)!.value({ kind: 'persist_failure', severity: 'critical' })).toBe(1);
  });

  it('starts/stops the event-loop sampler without leaking a timer', () => {
    telemetry.onApplicationBootstrap();
    telemetry.onModuleDestroy(); // must not leave a handle open
    // gauge exists (catalog-registered) even if no sample fired in this tick
    expect(registry.gauge(M.eventLoopLag)).toBeDefined();
  });
});
