import { CompositeBiasSource } from './composite-bias-source';
import { BiasReading, IBiasSource } from './bias-source.interface';

function fixed(r: BiasReading): IBiasSource {
  return { bias: () => r };
}
const ctx = { nowMs: 0 };

describe('CompositeBiasSource — systematic default, house-view override capped by data', () => {
  it('no manual view ⇒ the systematic default drives', () => {
    const c = new CompositeBiasSource(
      fixed({ bias: -0.4, validated: true, reason: 'funding' }),
      fixed({ bias: 0, validated: true, reason: 'no view' }),
    );
    expect(c.bias('BTC', ctx).bias).toBeCloseTo(-0.4);
  });

  it('manual view that AGREES in sign with the data ⇒ the house conviction is used', () => {
    const c = new CompositeBiasSource(
      fixed({ bias: -0.3, validated: true, reason: 'funding' }),
      fixed({ bias: -0.8, validated: true, reason: 'thesis' }),
    );
    expect(c.bias('BTC', ctx).bias).toBeCloseTo(-0.8);
  });

  it('manual view that CONFLICTS with a live, validated data signal ⇒ stand aside (data wins)', () => {
    const c = new CompositeBiasSource(
      fixed({ bias: -0.5, validated: true, reason: 'funding' }),
      fixed({ bias: 0.8, validated: true, reason: 'thesis' }),
    );
    expect(c.bias('BTC', ctx).bias).toBe(0);
  });

  it('an UNVALIDATED manual view falls back to the systematic', () => {
    const c = new CompositeBiasSource(
      fixed({ bias: -0.4, validated: true, reason: 'funding' }),
      fixed({ bias: 0.9, validated: false, reason: 'unproven' }),
    );
    expect(c.bias('BTC', ctx).bias).toBeCloseTo(-0.4);
  });

  it('a manual view with a NEUTRAL systematic ⇒ the view is used (nothing to conflict)', () => {
    const c = new CompositeBiasSource(
      fixed({ bias: 0, validated: true, reason: 'flat' }),
      fixed({ bias: 0.7, validated: true, reason: 'thesis' }),
    );
    expect(c.bias('BTC', ctx).bias).toBeCloseTo(0.7);
  });
});
