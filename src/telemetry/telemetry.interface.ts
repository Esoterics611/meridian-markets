// ITelemetry — the observability swap seam (CLAUDE.md §7, TELEMETRY_REQUIREMENTS.md
// DC-1). A NullTelemetry (no-op, default) keeps `TELEMETRY_ENABLED=false` runs +
// every existing test behaving exactly as before with near-zero overhead; a
// PrometheusTelemetry writes the §4 metric catalog into an in-memory registry
// exposed at `GET /metrics`. Selected by config in the @Global TelemetryModule.
//
// The contract is deliberately tiny — counter / gauge / histogram + a uniform
// alert hook — so instrumentation call-sites stay one line and impl-agnostic.
// DC-5: every method is best-effort and MUST NOT throw — an emit error is
// swallowed and counted, never failing a tick.

export const TELEMETRY = Symbol('TELEMETRY');

/** Bounded label set (DC-4): book / source / strategy / verdict / result — never
 *  per-order ids or timestamps. */
export type MetricLabels = Record<string, string>;

export type AlertSeverity = 'info' | 'warn' | 'critical';

/**
 * A uniform alert/event (FR-10): drawdown breach, stale feed, risk Deny/Pause,
 * persistence failure, WS disconnect, tick overrun. P1 maps an alert to a counter
 * (`meridian_alerts_total{kind,severity}`) + a structured log line; delivery
 * (webhook/Slack) is pluggable later. The requirement is that the event *exists
 * and is uniform*, not how it's delivered.
 */
export interface AlertEvent {
  /** Stable, bounded kind (used as a metric label) — e.g. 'tick_overrun'. */
  kind: string;
  message: string;
  severity?: AlertSeverity;
  book?: string;
  source?: string;
}

export interface ITelemetry {
  /** False for NullTelemetry; lets hot paths skip building label objects. */
  readonly enabled: boolean;
  /** Increment a counter (default +1). A negative/NaN delta or unknown name is ignored. */
  counter(name: string, labels?: MetricLabels, delta?: number): void;
  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number, labels?: MetricLabels): void;
  /** Observe a value into a histogram. */
  histogram(name: string, value: number, labels?: MetricLabels): void;
  /** Emit a uniform alert event. */
  alert(event: AlertEvent): void;
}
