import { estimateSlippage } from './slippage-model';

describe('estimateSlippage', () => {
  it('returns zero impact when notional is zero', () => {
    expect(estimateSlippage({ notionalUnits: 0n, advUnits: 1_000_000_000n }).impactBps).toBe(0);
  });

  it('scales linearly with notional / ADV', () => {
    const small = estimateSlippage({ notionalUnits: 1_000_000n, advUnits: 100_000_000n });    // 1% of ADV
    const big   = estimateSlippage({ notionalUnits: 2_000_000n, advUnits: 100_000_000n });    // 2% of ADV
    expect(big.impactBps).toBeCloseTo(small.impactBps * 2);
  });

  it('uses default lambda = 100 bps per 1% of ADV', () => {
    const r = estimateSlippage({ notionalUnits: 1_000_000n, advUnits: 100_000_000n }); // 1% of ADV
    expect(r.impactBps).toBeCloseTo(1.0);
  });

  it('respects a custom lambda', () => {
    const r = estimateSlippage({
      notionalUnits: 1_000_000n, advUnits: 100_000_000n,
      lambdaBps: 50,
    });
    expect(r.impactBps).toBeCloseTo(0.5);
  });

  it('caps impact at 10% (1000 bps) for absurd orders', () => {
    const r = estimateSlippage({ notionalUnits: 1_000_000_000_000n, advUnits: 1n });
    expect(r.impactBps).toBe(1000);
  });

  it('signs impact by side', () => {
    const buy  = estimateSlippage({ notionalUnits: 1_000_000n, advUnits: 100_000_000n, side: 'BUY' });
    const sell = estimateSlippage({ notionalUnits: 1_000_000n, advUnits: 100_000_000n, side: 'SELL' });
    expect(buy.signedImpactBps).toBeGreaterThan(0);
    expect(sell.signedImpactBps).toBeLessThan(0);
    expect(Math.abs(buy.signedImpactBps)).toBeCloseTo(Math.abs(sell.signedImpactBps));
  });

  it('costUnits = notional * impactBps / 10000', () => {
    const r = estimateSlippage({ notionalUnits: 10_000_000n, advUnits: 1_000_000_000n }); // 1% ADV, 1bp impact
    // 10_000_000 * 1 / 10_000 = 1_000
    expect(r.costUnits).toBe(1_000n);
  });

  it('falls back to 500 bps when ADV is unknown', () => {
    const r = estimateSlippage({ notionalUnits: 1_000_000n, advUnits: 0n });
    expect(r.impactBps).toBe(500);
  });
});
