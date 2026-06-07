import { FundingBiasSource } from './funding-bias-source';

const ctx = (fundingRatePerHour: number) => ({ fundingRatePerHour, nowMs: 0 });

describe('FundingBiasSource — be long the funding-paid side', () => {
  const full = 0.0000125; // ~11%/yr maps to |b|=1

  it('positive funding (longs pay) ⇒ SHORT bias (negative)', () => {
    const r = new FundingBiasSource({ fullBiasRatePerHour: full, validated: true }).bias('BTC', ctx(full));
    expect(r.bias).toBeCloseTo(-1);
    expect(r.reason).toContain('short');
  });

  it('negative funding (shorts pay) ⇒ LONG bias (positive)', () => {
    const r = new FundingBiasSource({ fullBiasRatePerHour: full, validated: true }).bias('BTC', ctx(-full / 2));
    expect(r.bias).toBeCloseTo(0.5);
    expect(r.reason).toContain('long');
  });

  it('caps the magnitude at maxBias', () => {
    const r = new FundingBiasSource({ fullBiasRatePerHour: full, maxBias: 0.3, validated: true }).bias('BTC', ctx(full * 10));
    expect(r.bias).toBeCloseTo(-0.3);
  });

  it('flat funding ⇒ neutral', () => {
    expect(new FundingBiasSource({ fullBiasRatePerHour: full, validated: true }).bias('BTC', ctx(0)).bias).toBe(0);
  });

  it('defaults to UNVALIDATED — funding-as-direction must pass the OOS gate first', () => {
    expect(new FundingBiasSource({ fullBiasRatePerHour: full }).bias('BTC', ctx(full)).validated).toBe(false);
  });
});
