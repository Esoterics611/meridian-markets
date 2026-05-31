import { stdev, expectedEdgeFraction, roundTripFeeFraction, entryClearsFees } from './fee-gate';

describe('fee-gate helpers', () => {
  it('stdev matches the population std', () => {
    expect(stdev([1, 1, 1])).toBe(0);
    expect(stdev([0, 2])).toBe(1); // mean 1, var 1
  });

  it('expectedEdgeFraction is the reversion past exitZ, floored at zero', () => {
    expect(expectedEdgeFraction(2, 0.5, 0.01)).toBeCloseTo(0.015, 12); // (2-0.5)*0.01
    expect(expectedEdgeFraction(0.4, 0.5, 0.01)).toBe(0); // below exit, no edge
  });

  it('roundTripFeeFraction counts four legs', () => {
    expect(roundTripFeeFraction(5)).toBeCloseTo(0.002, 12); // 4 * 5/10000
  });

  it('is disabled (always passes) when feeBps <= 0', () => {
    expect(entryClearsFees(2, 0.5, 0.0000001, 0)).toBe(true);
    expect(entryClearsFees(2, 0.5, 0.0000001, -5)).toBe(true);
  });

  it('blocks a sub-fee edge and allows one that clears the fee × safety multiple', () => {
    // tiny σ (peg-like) → edge below the fee floor → blocked.
    expect(entryClearsFees(2, 0.5, 0.0005, 5, 1.5)).toBe(false);
    // healthy σ → edge clears 1.5 × round-trip fee → allowed.
    expect(entryClearsFees(2, 0.5, 0.02, 5, 1.5)).toBe(true);
  });
});
