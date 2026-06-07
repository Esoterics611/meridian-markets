import { RollingIcFlowBiasSource } from './rolling-ic-flow-bias-source';
import { BiasContext, effectiveBias } from './bias-source.interface';

// Drive the source N steps at 1s spacing with horizon=1s, so the forward pair for obs i is
// obs i+1 and fwd[i] = mid[i+1]/mid[i]−1. `follow` sets whether the mid moves WITH the
// signal (+1, predictive ⇒ IC→+1) or AGAINST it (−1, reversal ⇒ IC→−1).
function drive(follow: 1 | -1, n = 200): RollingIcFlowBiasSource {
  const src = new RollingIcFlowBiasSource({
    fullBiasImbalance: 0.6,
    horizonMs: 1000,
    evalEveryMs: 1000,
    minPairs: 50,
    icThreshold: 0.05,
  });
  let mid = 1_000_000;
  for (let i = 0; i < n; i++) {
    const imb = 0.6 * Math.sin(i / 5); // persistent, signed, varied
    const ctx: BiasContext = { nowMs: i * 1000, bookImbalance: imb, midMicros: BigInt(Math.round(mid)) };
    src.bias('BTC', ctx);
    const b = imb / 0.6; // the emitted bias ≈ sin(i/5)
    mid = mid * (1 + follow * 0.0005 * b);
  }
  return src;
}

describe('RollingIcFlowBiasSource', () => {
  it('validates + sizes carry once its trailing forward-IC is positive', () => {
    const src = drive(1);
    expect(src.isValidated).toBe(true);
    expect(src.ic).toBeGreaterThan(0.5);
    // a non-zero imbalance now sizes carry (validated ⇒ effectiveBias passes it through)
    const r = src.bias('BTC', { nowMs: 999_000, bookImbalance: 0.6, midMicros: 1_000_000n });
    expect(effectiveBias(r)).toBeGreaterThan(0);
  });

  it('stands aside (no carry) when the signal is REVERSING — never flips the sign live', () => {
    const src = drive(-1);
    expect(src.isValidated).toBe(false);
    expect(src.ic).toBeLessThan(0); // anti-predictive
    const r = src.bias('BTC', { nowMs: 999_000, bookImbalance: 0.6, midMicros: 1_000_000n });
    expect(effectiveBias(r)).toBe(0);
  });

  it('stays unvalidated while warming (too few scored pairs)', () => {
    const src = new RollingIcFlowBiasSource({ fullBiasImbalance: 0.6, horizonMs: 1000, evalEveryMs: 1000, minPairs: 50 });
    let mid = 1_000_000;
    for (let i = 0; i < 10; i++) {
      src.bias('BTC', { nowMs: i * 1000, bookImbalance: 0.6 * Math.sin(i), midMicros: BigInt(Math.round(mid)) });
      mid *= 1.0001;
    }
    expect(src.isValidated).toBe(false);
    expect(src.bias('BTC', { nowMs: 11_000, bookImbalance: 0.6, midMicros: 1_000_000n }).reason).toContain('warming');
  });
});
