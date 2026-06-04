import { FundingPoint } from './funding-source.interface';
import { staticCarry, CarryInputs } from './funding-carry';

const ONE_M = 1_000_000_000_000n; // $1,000,000 in 6-dec units

function fp(rate: number, markPrice = 100, fundingTimeMs = 0): FundingPoint {
  return { symbol: 'BTC', fundingTimeMs, fundingRate: rate, markPrice };
}

function base(over: Partial<CarryInputs> = {}): CarryInputs {
  return {
    funding: [fp(0.0001, 100, 0), fp(0.0001, 100, 8 * 3600_000), fp(0.0001, 100, 16 * 3600_000)],
    spotEntry: 100,
    spotExit: 100,
    perpEntry: 100,
    perpExit: 100,
    notionalUnits: ONE_M,
    spotFeeBps: 10,
    perpFeeBps: 5,
    ...over,
  };
}

describe('staticCarry', () => {
  it('harvests positive funding on the short-perp leg', () => {
    const r = staticCarry(base());
    // 3 settlements × 1bp × $1M = $300
    expect(r.fundingCollectedUnits).toBe(300_000_000n);
    expect(r.positiveFraction).toBe(1);
    expect(r.periods).toBe(3);
  });

  it('charges a 4-fill round trip and nets funding − fees', () => {
    const r = staticCarry(base());
    // round trip = 2 × (10 + 5) bps × $1M = 30 bps × $1M = $3,000
    expect(r.feesUnits).toBe(3_000_000_000n);
    // net = $300 funding − $3,000 fees = −$2,700 (fees dominate a 3-period hold)
    expect(r.netUnits).toBe(-2_700_000_000n);
  });

  it('negative funding means the short leg PAYS', () => {
    const r = staticCarry(base({ funding: [fp(-0.0002, 100, 0)] }));
    expect(r.fundingCollectedUnits).toBe(-200_000_000n); // −2bp × $1M
    expect(r.positiveFraction).toBe(0);
  });

  it('keeps the basis move on a delta-neutral book', () => {
    // spot rose 1%, perp flat ⇒ long spot + short perp earns the 1% basis on $1M.
    const r = staticCarry(base({ spotExit: 101, perpExit: 100 }));
    expect(r.basisPnlUnits).toBe(10_000_000_000n); // +$10,000
  });

  it('annualises funding from the per-8h mean', () => {
    const r = staticCarry(base());
    expect(r.meanFundingPerPeriod).toBeCloseTo(0.0001, 9);
    // 0.0001 × (365×24/8) × 100 ≈ 10.95% / yr
    expect(r.annualizedFundingPct).toBeCloseTo(10.95, 1);
  });

  it('is empty-safe', () => {
    const r = staticCarry(base({ funding: [] }));
    expect(r.periods).toBe(0);
    expect(r.fundingCollectedUnits).toBe(0n);
    expect(r.annualizedNetPct).toBe(0);
  });

  it('accrues funding on entry notional when the source omits mark (markPrice 0)', () => {
    // HL fundingHistory carries no mark ⇒ markPrice 0. A literal mark/perpEntry would
    // zero funding; the guard accrues on notional instead. 1 settlement × 1bp × $1M.
    const r = staticCarry(base({ funding: [fp(0.0001, 0, 0)] }));
    expect(r.fundingCollectedUnits).toBe(100_000_000n);
  });

  it('annualises on a venue-specific periodsPerYear (HL hourly = 8760)', () => {
    const r = staticCarry(base({ periodsPerYear: 8760 }));
    // 0.0001 × 8760 × 100 = 87.6% / yr (vs 10.95% at the Binance 8h cadence)
    expect(r.annualizedFundingPct).toBeCloseTo(87.6, 1);
  });
});
