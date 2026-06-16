import { ConsensusBiasSource } from './consensus-bias-source';
import { BiasContext, BiasReading, IBiasSource } from '../bias/bias-source.interface';
import { NullBiasSource } from '../bias/null-bias-source';

// A fixed-reading stub source — the unit under test only cares about each source's reading.
class StubSource implements IBiasSource {
  constructor(private readonly r: BiasReading) {}
  bias(): BiasReading {
    return this.r;
  }
}

const ctx: BiasContext = { nowMs: 0 };
const long = (validated = true): BiasReading => ({ bias: 0.6, validated, reason: 'long' });
const short = (validated = true): BiasReading => ({ bias: -0.4, validated, reason: 'short' });

describe('ConsensusBiasSource', () => {
  it('expresses a view only when ≥ minAgree validated sources agree in sign', () => {
    const c = new ConsensusBiasSource([new StubSource(long()), new StubSource(long())], { minAgree: 2 });
    const r = c.bias('BTC', ctx);
    expect(r.bias).toBeCloseTo(0.6, 6);
    expect(r.validated).toBe(true);
    expect(r.reason).toContain('agree long');
  });

  it('returns neutral when fewer than minAgree agree', () => {
    const c = new ConsensusBiasSource([new StubSource(long()), new NullBiasSource()], { minAgree: 2 });
    expect(c.bias('BTC', ctx).bias).toBe(0);
  });

  it('vetoes on conflict (one long, one short) — stands aside', () => {
    const c = new ConsensusBiasSource([new StubSource(long()), new StubSource(short())], { minAgree: 1 });
    const r = c.bias('BTC', ctx);
    expect(r.bias).toBe(0);
    expect(r.reason).toContain('conflict');
  });

  it('without vetoOnConflict, the majority side wins', () => {
    const c = new ConsensusBiasSource(
      [new StubSource(long()), new StubSource(long()), new StubSource(short())],
      { minAgree: 2, vetoOnConflict: false },
    );
    const r = c.bias('BTC', ctx);
    expect(r.bias).toBeGreaterThan(0); // 2 longs beat 1 short
  });

  it('ignores UNVALIDATED constituents (the OOS gate is enforced per source)', () => {
    // Two strong long readings, but neither validated ⇒ no vote ⇒ neutral.
    const c = new ConsensusBiasSource([new StubSource(long(false)), new StubSource(long(false))], { minAgree: 1 });
    expect(c.bias('BTC', ctx).bias).toBe(0);
  });

  it('averages the agreeing biases', () => {
    const c = new ConsensusBiasSource(
      [new StubSource({ bias: 0.4, validated: true, reason: 'a' }), new StubSource({ bias: 0.8, validated: true, reason: 'b' })],
      { minAgree: 2 },
    );
    expect(c.bias('BTC', ctx).bias).toBeCloseTo(0.6, 6);
  });

  it('an all-neutral set yields a neutral, validated reading', () => {
    const c = new ConsensusBiasSource([new NullBiasSource(), new NullBiasSource()]);
    const r = c.bias('BTC', ctx);
    expect(r.bias).toBe(0);
    expect(r.validated).toBe(true);
  });
});
