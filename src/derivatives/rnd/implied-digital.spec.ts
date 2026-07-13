import { impliedDigital, ivAtStrike } from './implied-digital';

describe('impliedDigital', () => {
  // Locked to the 2026-07-13 18:08 UTC live read: BTC spot 61,943.38 (Deribit),
  // HIP-4 outcome 823 (targetPrice 62,814, expiry 2026-07-14 06:00 UTC, T=0.001352y),
  // 62.5k/63k mark IVs 0.3517/0.3604 ⇒ iv(K)=0.3572, skew=1.74e-5/$.
  // HIP-4 quoted YES 0.153/0.180 vs smile-adjusted fair 0.1334 — the founding gap.
  const live = { spot: 61943.38, strike: 62814, tYears: 0.001352, iv: 0.3572, skewPerDollar: 0.0000174 };

  it('reproduces the founding live read (naive 0.1425, smile-adjusted 0.1334)', () => {
    const d = impliedDigital(live);
    expect(d.naive).toBeCloseTo(0.1425, 3);
    expect(d.smileAdjusted).toBeCloseTo(0.1334, 3);
  });

  it('positive call-wing skew lowers the digital below naive', () => {
    const d = impliedDigital(live);
    expect(d.smileAdjusted).toBeLessThan(d.naive);
    const flat = impliedDigital({ ...live, skewPerDollar: 0 });
    expect(flat.smileAdjusted).toBeCloseTo(flat.naive, 12);
  });

  it('is monotone decreasing in strike', () => {
    const lo = impliedDigital({ ...live, strike: 60000 });
    const hi = impliedDigital({ ...live, strike: 66000 });
    expect(lo.naive).toBeGreaterThan(hi.naive);
  });

  it('deep ITM → 1, deep OTM → 0', () => {
    expect(impliedDigital({ ...live, strike: 30000 }).smileAdjusted).toBeGreaterThan(0.999);
    expect(impliedDigital({ ...live, strike: 120000 }).smileAdjusted).toBeLessThan(0.001);
  });

  it('P(S>K) + P(S<K) = 1 for the naive digital', () => {
    const above = impliedDigital(live).naive;
    // N(-d2) is the below-probability; reconstruct via strike/spot symmetry of d2.
    const d = impliedDigital(live);
    expect(above + (1 - d.naive)).toBeCloseTo(1, 12);
  });

  it('settles to indicator at expiry (T=0)', () => {
    expect(impliedDigital({ ...live, tYears: 0, strike: 60000 }).smileAdjusted).toBe(1);
    expect(impliedDigital({ ...live, tYears: 0, strike: 63000 }).smileAdjusted).toBe(0);
  });

  it('clamps the smile adjustment into [0,1]', () => {
    const d = impliedDigital({ ...live, skewPerDollar: 1 }); // absurd skew
    expect(d.smileAdjusted).toBe(0);
  });
});

describe('ivAtStrike', () => {
  const smile = [
    { strike: 62000, iv: 0.3624 },
    { strike: 62500, iv: 0.3517 },
    { strike: 63000, iv: 0.3604 },
    { strike: 63500, iv: 0.3843 },
  ];

  it('interpolates inside the bracket with the local slope', () => {
    const r = ivAtStrike(smile, 62814);
    expect(r.iv).toBeCloseTo(0.3517 + ((0.3604 - 0.3517) / 500) * 314, 6);
    expect(r.skewPerDollar).toBeCloseTo((0.3604 - 0.3517) / 500, 9);
  });

  it('clamps IV below the lowest strike, keeps nearest slope', () => {
    const r = ivAtStrike(smile, 61000);
    expect(r.iv).toBeCloseTo(0.3624, 9);
    expect(r.skewPerDollar).toBeCloseTo((0.3517 - 0.3624) / 500, 9);
  });

  it('clamps IV above the highest strike, keeps nearest slope', () => {
    const r = ivAtStrike(smile, 70000);
    expect(r.iv).toBeCloseTo(0.3843, 9);
    expect(r.skewPerDollar).toBeCloseTo((0.3843 - 0.3604) / 500, 9);
  });

  it('throws on fewer than 2 points', () => {
    expect(() => ivAtStrike([{ strike: 62000, iv: 0.36 }], 62500)).toThrow(/≥2 vol points/);
  });
});
