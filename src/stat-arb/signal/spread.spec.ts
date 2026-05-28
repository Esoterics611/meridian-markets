import { logSpread } from './spread';

describe('logSpread', () => {
  it('with beta = 1 reduces to log(A/B)', () => {
    const a = [100, 200, 300];
    const b = [100, 100, 100];
    const out = logSpread(a, b, 1);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(Math.log(2), 10);
    expect(out[2]).toBeCloseTo(Math.log(3), 10);
  });

  it('matches the closed-form log(A) - beta*log(B)', () => {
    const out = logSpread([10, 20], [5, 10], 0.5);
    expect(out[0]).toBeCloseTo(Math.log(10) - 0.5 * Math.log(5), 10);
    expect(out[1]).toBeCloseTo(Math.log(20) - 0.5 * Math.log(10), 10);
  });

  it('throws when lengths differ', () => {
    expect(() => logSpread([1, 2], [1], 1)).toThrow(/same length/);
  });
});
