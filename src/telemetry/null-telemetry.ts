import { AlertEvent, ITelemetry, MetricLabels } from './telemetry.interface';

// NullTelemetry — the no-op default (DC-1). With `TELEMETRY_ENABLED=false` every
// instrumentation call lands here: empty methods, `enabled=false`. This is what
// keeps the full test suite + a no-config run behaving exactly as before with no
// measurable overhead (NFR-4). Shared singleton so a default param costs nothing.
export class NullTelemetry implements ITelemetry {
  readonly enabled = false;
  counter(_name: string, _labels?: MetricLabels, _delta?: number): void {}
  gauge(_name: string, _value: number, _labels?: MetricLabels): void {}
  histogram(_name: string, _value: number, _labels?: MetricLabels): void {}
  alert(_event: AlertEvent): void {}
}

/** Process-wide no-op instance — use as the default when no telemetry is injected. */
export const NULL_TELEMETRY: ITelemetry = new NullTelemetry();
