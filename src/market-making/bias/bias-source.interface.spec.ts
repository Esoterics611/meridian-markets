import { clampBias, effectiveBias, NEUTRAL_BIAS } from './bias-source.interface';
import { NullBiasSource } from './null-bias-source';

describe('clampBias', () => {
  it('clamps into [-1,1] and maps NaN/∞ to 0', () => {
    expect(clampBias(0.4)).toBe(0.4);
    expect(clampBias(2)).toBe(1);
    expect(clampBias(-2)).toBe(-1);
    expect(clampBias(NaN)).toBe(0);
    expect(clampBias(Infinity)).toBe(0);
  });
});

describe('effectiveBias — the OOS-gate enforcement', () => {
  it('passes a validated bias through (clamped)', () => {
    expect(effectiveBias({ bias: 0.5, validated: true, reason: '' })).toBe(0.5);
    expect(effectiveBias({ bias: 5, validated: true, reason: '' })).toBe(1);
  });
  it('zeroes an UNVALIDATED bias — no carry from an unproven view', () => {
    expect(effectiveBias({ bias: 0.8, validated: false, reason: '' })).toBe(0);
  });
});

describe('NullBiasSource', () => {
  it('is always neutral (b=0 ⇒ identical to today’s GLFT)', () => {
    expect(new NullBiasSource().bias('BTC', { nowMs: 0 })).toEqual(NEUTRAL_BIAS);
  });
});
