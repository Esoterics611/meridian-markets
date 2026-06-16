import { effectiveBias } from './bias-source.interface';
import { MomentumBiasSource } from './momentum-bias-source';

const ctx = (recentReturns: number[]) => ({ recentReturns, nowMs: 0 });

describe('MomentumBiasSource', () => {
  it('leans LONG on a positive trailing trend, SHORT on a negative one', () => {
    const src = new MomentumBiasSource({ fullBiasReturn: 0.05, validated: true });
    const up = src.bias('BTC', ctx([0.01, 0.01, 0.01]));
    expect(up.bias).toBeGreaterThan(0);
    expect(up.reason).toBe('momentum up');
    const down = src.bias('BTC', ctx([-0.01, -0.02]));
    expect(down.bias).toBeLessThan(0);
  });

  it('sizes ZERO until validated (the OOS gate is part of the contract)', () => {
    const src = new MomentumBiasSource({ fullBiasReturn: 0.05 }); // validated defaults false
    const r = src.bias('BTC', ctx([0.03, 0.03]));
    expect(r.validated).toBe(false);
    expect(effectiveBias(r)).toBe(0); // unvalidated ⇒ no position
    expect(r.bias).toBeGreaterThan(0); // the raw view exists; the gate is what zeroes it
  });

  it('scales with the trend and clamps at the full-bias return', () => {
    const src = new MomentumBiasSource({ fullBiasReturn: 0.05, validated: true });
    expect(src.bias('BTC', ctx([0.025])).bias).toBeCloseTo(0.5, 6); // half of full
    expect(src.bias('BTC', ctx([0.5])).bias).toBe(1); // clamped to +1
  });

  it('respects the lookback window (only the most-recent N returns)', () => {
    const src = new MomentumBiasSource({ fullBiasReturn: 0.05, lookback: 2, validated: true });
    // older +0.04 ignored; last two sum to -0.02 ⇒ short
    expect(src.bias('BTC', ctx([0.04, -0.01, -0.01])).bias).toBeLessThan(0);
  });

  it('is flat with no returns or a zero trend', () => {
    const src = new MomentumBiasSource({ fullBiasReturn: 0.05, validated: true });
    expect(src.bias('BTC', ctx([])).bias).toBe(0);
    expect(src.bias('BTC', ctx([0.01, -0.01])).bias).toBe(0);
  });
});
