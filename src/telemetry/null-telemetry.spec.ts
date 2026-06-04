import { NULL_TELEMETRY, NullTelemetry } from './null-telemetry';

describe('NullTelemetry — the no-op default', () => {
  it('is disabled and never throws on any emit', () => {
    const t = new NullTelemetry();
    expect(t.enabled).toBe(false);
    expect(() => {
      t.counter('anything', { a: 'b' }, 5);
      t.gauge('anything', 1);
      t.histogram('anything', 0.2, { s: 'x' });
      t.alert({ kind: 'whatever', message: 'noop', severity: 'critical' });
    }).not.toThrow();
  });

  it('exports a shared singleton', () => {
    expect(NULL_TELEMETRY.enabled).toBe(false);
  });
});
