import { RegimeBetaHedge } from '../directional/regime-beta-hedge';
import { allocateCarry, CarryAllocatorConfig, CarryCandidate } from './carry-allocator';

const CFG: CarryAllocatorConfig = {
  totalNotionalUsd: 10_000,
  maxLegs: 12,
  maxWeightPerLeg: 0.15,
  minAnnualRateFrac: 0.05,
  rateTilt: false,
};

function cand(symbol: string, rate: number, over: Partial<CarryCandidate> = {}): CarryCandidate {
  return {
    symbol,
    annualRateFrac: rate,
    persistenceFrac: 0.8,
    deployable: true,
    residualDeltaFracOfNotional: 0, // two-leg delta-neutral pair
    beta: 1,
    ...over,
  };
}

describe('allocateCarry v0 (fixed weights)', () => {
  it('equal-weights the eligible legs and prices the expected gross rate', () => {
    const r = allocateCarry([cand('ETH', 0.1), cand('BNB', 0.08), cand('TAO', 0.12)], CFG);
    expect(r.allocations.length).toBe(3);
    for (const a of r.allocations) {
      expect(a.weight).toBeCloseTo(1 / 3 > CFG.maxWeightPerLeg ? CFG.maxWeightPerLeg : 1 / 3, 9);
    }
    // 3 legs → 1/3 > 0.15 cap → capped at 0.15 each, 55% cash
    expect(r.allocations[0].weight).toBeCloseTo(0.15, 9);
    expect(r.cashWeight).toBeCloseTo(1 - 0.45, 9);
    expect(r.expectedGrossRateFrac).toBeCloseTo(0.15 * (0.12 + 0.1 + 0.08), 9);
    expect(r.allocations[0].symbol).toBe('TAO'); // sorted by rate
  });

  it('filters non-deployable and sub-rate legs (no edge → no position)', () => {
    const r = allocateCarry(
      [cand('ETH', 0.1), cand('LIT', 0.5, { deployable: false }), cand('DOGE', 0.03)],
      CFG,
    );
    expect(r.allocations.map((a) => a.symbol)).toEqual(['ETH']);
    expect(r.cashWeight).toBeGreaterThan(0.8);
  });

  it('respects maxLegs, keeps the best-rate legs', () => {
    const many = Array.from({ length: 20 }, (_, i) => cand(`S${i}`, 0.05 + i * 0.01));
    const r = allocateCarry(many, { ...CFG, maxLegs: 5 });
    expect(r.allocations.length).toBe(5);
    expect(r.allocations[0].symbol).toBe('S19');
  });

  it('empty eligible set → all cash, no hedge legs', () => {
    const r = allocateCarry([cand('ETH', 0.01)], CFG);
    expect(r.allocations).toEqual([]);
    expect(r.cashWeight).toBe(1);
    expect(r.bookBetas).toEqual([]);
  });

  it('rate tilt weights ∝ rate under the cap and never exceeds it', () => {
    const r = allocateCarry(
      [cand('A', 0.2), cand('B', 0.1), cand('C', 0.1)],
      { ...CFG, rateTilt: true, maxWeightPerLeg: 0.4 },
    );
    expect(r.allocations.find((a) => a.symbol === 'A')!.weight).toBeCloseTo(0.4, 9); // 0.5 capped
    for (const a of r.allocations) expect(a.weight).toBeLessThanOrEqual(0.4 + 1e-12);
  });
});

describe('allocateCarry → RegimeBetaHedge integration', () => {
  it('delta-neutral pairs need no hedge; naked HL-only legs roll into one hedge target', () => {
    const r = allocateCarry(
      [
        cand('ETH', 0.1), // pair, residual 0
        cand('FARTCOIN', 0.3, { residualDeltaFracOfNotional: -1, beta: 0.8 }), // naked short perp
        cand('HYPE', 0.25, { residualDeltaFracOfNotional: -1, beta: 1.2 }),
      ],
      { ...CFG, maxWeightPerLeg: 0.2 },
    );
    expect(r.bookBetas.length).toBe(2); // ETH pair contributes nothing
    const hedge = new RegimeBetaHedge({ hedgeSymbol: 'BTC' });
    const target = hedge.targetNotionalUsd(r.bookBetas);
    // both residuals are short → hedge target is LONG BTC of the beta-weighted sum
    const expected = -(-2000 * 0.8 + -2000 * 1.2);
    expect(target).toBeCloseTo(expected, 6);
    expect(target).toBeGreaterThan(0);
  });
});
