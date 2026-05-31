import { RollingVolatility } from './volatility';

describe('RollingVolatility', () => {
  it('is not ready until window+1 closes seen, then returns a finite σ', () => {
    const v = new RollingVolatility(3);
    v.push(100);
    v.push(101);
    v.push(100);
    expect(v.ready()).toBe(false);
    v.push(102);
    expect(v.ready()).toBe(true);
    expect(Number.isFinite(v.value())).toBe(true);
  });

  it('reports zero σ on a perfectly flat series and the floor via valueOr', () => {
    const v = new RollingVolatility(3);
    for (const c of [100, 100, 100, 100]) v.push(c);
    expect(v.value()).toBeCloseTo(0, 12);
    expect(v.valueOr(0.001)).toBe(0.001); // floor kicks in
  });

  it('rises when the series gets noisier', () => {
    const calm = new RollingVolatility(5);
    const wild = new RollingVolatility(5);
    [100, 100.1, 100.0, 100.1, 100.0, 100.1].forEach((c) => calm.push(c));
    [100, 103, 98, 104, 97, 105].forEach((c) => wild.push(c));
    expect(wild.value()).toBeGreaterThan(calm.value());
  });
});
