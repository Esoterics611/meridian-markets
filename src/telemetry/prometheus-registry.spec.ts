import { PrometheusRegistry } from './prometheus-registry';

describe('PrometheusRegistry — text exposition', () => {
  it('renders HELP + TYPE + sample for a counter, summing repeated incs', () => {
    const reg = new PrometheusRegistry();
    const c = reg.registerCounter('meridian_test_total', 'a test counter');
    c.inc({ result: 'ok' });
    c.inc({ result: 'ok' });
    c.inc({ result: 'error' }, 3);
    const out = reg.render();
    expect(out).toContain('# HELP meridian_test_total a test counter');
    expect(out).toContain('# TYPE meridian_test_total counter');
    expect(out).toContain('meridian_test_total{result="ok"} 2');
    expect(out).toContain('meridian_test_total{result="error"} 3');
  });

  it('ignores negative / NaN counter deltas (counters never decrease)', () => {
    const reg = new PrometheusRegistry();
    const c = reg.registerCounter('meridian_c_total', 'c');
    c.inc({}, 5);
    c.inc({}, -2);
    c.inc({}, NaN);
    expect(c.value()).toBe(5);
  });

  it('gauge set overwrites and reset clears every series', () => {
    const reg = new PrometheusRegistry();
    const g = reg.registerGauge('meridian_g', 'g');
    g.set({ book: 'ETH' }, 10);
    g.set({ book: 'ETH' }, 20); // overwrite
    g.set({ book: 'BTC' }, 5);
    expect(g.value({ book: 'ETH' })).toBe(20);
    expect(reg.render()).toContain('meridian_g{book="BTC"} 5');
    g.reset();
    expect(g.value({ book: 'ETH' })).toBeUndefined();
    expect(reg.render()).not.toContain('meridian_g{book="ETH"}');
  });

  it('histogram emits cumulative le buckets, +Inf, _sum and _count', () => {
    const reg = new PrometheusRegistry();
    const h = reg.registerHistogram('meridian_h_seconds', 'h', [0.1, 1, 10]);
    h.observe({}, 0.05); // <= 0.1, 1, 10
    h.observe({}, 0.5); // <= 1, 10
    h.observe({}, 50); // <= +Inf only
    const out = reg.render();
    expect(out).toContain('meridian_h_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('meridian_h_seconds_bucket{le="1"} 2');
    expect(out).toContain('meridian_h_seconds_bucket{le="10"} 2');
    expect(out).toContain('meridian_h_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('meridian_h_seconds_count 3');
    expect(out).toContain('meridian_h_seconds_sum 50.55');
  });

  it('escapes quotes/backslashes in label values', () => {
    const reg = new PrometheusRegistry();
    const c = reg.registerCounter('meridian_e_total', 'e');
    c.inc({ msg: 'a"b\\c' });
    expect(reg.render()).toContain('meridian_e_total{msg="a\\"b\\\\c"} 1');
  });

  it('renders labels sorted so output is deterministic', () => {
    const reg = new PrometheusRegistry();
    const g = reg.registerGauge('meridian_s', 's');
    g.set({ zebra: '1', alpha: '2' }, 7);
    expect(reg.render()).toContain('meridian_s{alpha="2",zebra="1"} 7');
  });

  it('rejects re-registering a name with a different type', () => {
    const reg = new PrometheusRegistry();
    reg.registerCounter('meridian_x', 'x');
    expect(() => reg.registerGauge('meridian_x', 'x')).toThrow(/already registered/);
  });

  it('get-or-create returns the same instance for the same name', () => {
    const reg = new PrometheusRegistry();
    const a = reg.registerCounter('meridian_y_total', 'y');
    const b = reg.registerCounter('meridian_y_total', 'y');
    expect(a).toBe(b);
  });
});
