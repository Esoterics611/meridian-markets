import { FlowImbalanceBiasSource } from './flow-bias-source';
import { BiasContext, effectiveBias } from './bias-source.interface';

const ctx = (bookImbalance: number): BiasContext => ({ nowMs: 0, bookImbalance });

describe('FlowImbalanceBiasSource', () => {
  it('leans LONG on a bid-heavy book (+imbalance ⇒ +bias)', () => {
    const r = new FlowImbalanceBiasSource({ fullBiasImbalance: 0.6, validated: true }).bias('BTC', ctx(0.6));
    expect(r.bias).toBeCloseTo(1, 9);
    expect(r.reason).toContain('long');
  });

  it('leans SHORT on an ask-heavy book, scaled by the imbalance', () => {
    const r = new FlowImbalanceBiasSource({ fullBiasImbalance: 0.6, validated: true }).bias('BTC', ctx(-0.3));
    expect(r.bias).toBeCloseTo(-0.5, 9);
    expect(r.reason).toContain('short');
  });

  it('caps |bias| at maxBias', () => {
    const r = new FlowImbalanceBiasSource({ fullBiasImbalance: 0.2, maxBias: 0.5, validated: true }).bias('BTC', ctx(0.6));
    expect(r.bias).toBeCloseTo(0.5, 9);
  });

  it('is neutral on a flat book', () => {
    expect(new FlowImbalanceBiasSource({ fullBiasImbalance: 0.6, validated: true }).bias('BTC', ctx(0)).bias).toBe(0);
  });

  it('SHADOW by default ⇒ effectiveBias is 0 (sizes no carry) even on a strong raw signal', () => {
    const r = new FlowImbalanceBiasSource({ fullBiasImbalance: 0.6 }).bias('BTC', ctx(0.6)); // validated omitted ⇒ false
    expect(r.bias).toBeCloseTo(1, 9); // the raw reading is present (so it can be recorded)
    expect(effectiveBias(r)).toBe(0); // but the OOS gate zeroes it for quoting
  });
});
