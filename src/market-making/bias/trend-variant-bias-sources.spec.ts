import { ReversalBiasSource, VolScaledMomentumBiasSource } from './trend-variant-bias-sources';

const ctx = (recentReturns: number[]) => ({ recentReturns, nowMs: 0 });

describe('ReversalBiasSource', () => {
  it('sizes ZERO until validated (the OOS gate is part of the contract)', () => {
    const s = new ReversalBiasSource({ fullBiasReturn: 0.03 });
    expect(s.bias('BTC', ctx([0.02, 0.01])).validated).toBe(false);
  });
  it('FADES a recent pop: positive trailing return ⇒ short bias', () => {
    const s = new ReversalBiasSource({ fullBiasReturn: 0.03, validated: true });
    const r = s.bias('BTC', ctx([0.01, 0.01, 0.01])); // +0.03 trailing ⇒ full fade short
    expect(r.bias).toBeCloseTo(-1, 9);
    expect(r.reason).toMatch(/short/);
  });
  it('goes long when fading a recent dip', () => {
    const s = new ReversalBiasSource({ fullBiasReturn: 0.06, validated: true });
    const r = s.bias('BTC', ctx([-0.03])); // −3% pop ⇒ +0.5 long
    expect(r.bias).toBeCloseTo(0.5, 9);
  });
  it('is flat with no returns', () => {
    expect(new ReversalBiasSource({ fullBiasReturn: 0.03, validated: true }).bias('BTC', ctx([])).bias).toBe(0);
  });
});

describe('VolScaledMomentumBiasSource', () => {
  it('sizes ZERO until validated', () => {
    expect(new VolScaledMomentumBiasSource({ fullBiasZ: 1.5 }).bias('BTC', ctx([0.01, -0.01, 0.02])).validated).toBe(false);
  });
  it('is long when the vol-scaled trend (Σret/σ) is positive', () => {
    const s = new VolScaledMomentumBiasSource({ fullBiasZ: 1.5, validated: true });
    const r = s.bias('BTC', ctx([0.01, 0.02, 0.015, 0.005])); // net up, modest vol ⇒ long
    expect(r.bias).toBeGreaterThan(0);
  });
  it('is flat when realised vol is zero (no risk to scale by)', () => {
    const s = new VolScaledMomentumBiasSource({ fullBiasZ: 1.5, validated: true });
    expect(s.bias('BTC', ctx([0.01, 0.01, 0.01])).bias).toBe(0); // identical returns ⇒ σ≈0
  });
  it('scales bias by 1/σ: the same trend in a calmer tape is a stronger view', () => {
    const s = new VolScaledMomentumBiasSource({ fullBiasZ: 5, validated: true });
    const calm = s.bias('BTC', ctx([0.004, 0.005, 0.006, 0.005])).bias; // small steady up
    const noisy = s.bias('BTC', ctx([0.02, -0.015, 0.025, -0.01])).bias; // bigger swings, less net trend/σ
    expect(calm).toBeGreaterThan(noisy);
  });
});
