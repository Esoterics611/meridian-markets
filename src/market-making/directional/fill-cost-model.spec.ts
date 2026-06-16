import { NoSlippageModel, SlippageImpactModel, slippageCostUnits } from './fill-cost-model';

const MID = 50_000_000_000n; // $50,000 in price micros
const SIZE = 1_000_000n; // 1.0 asset unit (6-dec) ⇒ $50,000 notional

describe('FillCostModel', () => {
  describe('NoSlippageModel (the safe default — no regression)', () => {
    it('fills exactly at the mid on both sides', () => {
      const m = new NoSlippageModel();
      expect(m.fillPrice('BUY', SIZE, MID)).toBe(MID);
      expect(m.fillPrice('SELL', SIZE, MID)).toBe(MID);
    });
  });

  describe('SlippageImpactModel', () => {
    it('a BUY fills ABOVE the mid, a SELL BELOW (half-spread crossing)', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 5 });
      expect(m.fillPrice('BUY', SIZE, MID)).toBeGreaterThan(MID);
      expect(m.fillPrice('SELL', SIZE, MID)).toBeLessThan(MID);
    });

    it('the half-spread is symmetric: BUY above by the same fraction SELL is below', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 10 }); // 10bps = 0.001
      const buy = m.fillPrice('BUY', SIZE, MID);
      const sell = m.fillPrice('SELL', SIZE, MID);
      expect(buy - MID).toBe(MID - sell);
      expect(buy - MID).toBe(50_000_000n); // 0.001 × $50,000 = $50 in micros
    });

    it('larger size pays more impact (monotone in notional)', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 1, impactBpsPerMillionUsd: 20 });
      const small = m.fillPrice('BUY', 1_000_000n, MID); // $50k
      const big = m.fillPrice('BUY', 20_000_000n, MID); // $1M
      expect(big).toBeGreaterThan(small);
    });

    it('size 0 ⇒ no cost (fills at mid)', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 50, impactBpsPerMillionUsd: 100 });
      expect(m.fillPrice('BUY', 0n, MID)).toBe(MID);
      expect(slippageCostUnits(0n, MID, m.fillPrice('BUY', 0n, MID))).toBe(0n);
    });

    it('caps the adverse move at 500 bps for a pathological size', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 0, impactBpsPerMillionUsd: 10_000 });
      const buy = m.fillPrice('BUY', 1_000_000_000_000n, MID); // absurd size
      // 1.05 × MID is the hard cap.
      expect(buy).toBe((MID * 105n) / 100n);
    });

    it('slippageCostUnits is the positive cost of the worsened fill', () => {
      const m = new SlippageImpactModel({ halfSpreadBps: 10 });
      const buy = m.fillPrice('BUY', SIZE, MID);
      // |fill − mid| × size/1e6 = $50 × 1.0 = $50 in USDC-units.
      expect(slippageCostUnits(SIZE, MID, buy)).toBe(50_000_000n);
    });
  });
});
