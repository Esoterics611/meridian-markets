import { FundingPoint } from './funding-source.interface';
import { scoreFundingCarry, assembleFundingBoard, FundingDiscoveryConfig, FundingCarryScore } from './funding-carry-discovery';

const HOUR = 3_600_000;

/** A funding series of `n` settlements, each at `rate(i)` (signed fraction/hr). */
function series(n: number, rate: (i: number) => number, symbol = 'TEST'): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ symbol, fundingTimeMs: i * HOUR, fundingRate: rate(i), markPrice: 0 });
  }
  return out;
}

const cfg: FundingDiscoveryConfig = {
  spotFeeBps: 1,
  perpFeeBps: 2,
  periodsPerYear: 24 * 365, // HL hourly
  notionalUnits: 1_000_000_000n,
  minPeriods: 24,
  minStableFraction: 0.6,
  minAnnualizedFundingPct: 5,
  maxBreakevenDays: 30,
};

describe('scoreFundingCarry', () => {
  it('flags a persistently POSITIVE-funding perp as harvestable via SHORT_PERP', () => {
    const s = scoreFundingCarry('AAA', series(200, () => 0.0001), cfg)!;
    expect(s).not.toBeNull();
    expect(s.direction).toBe('SHORT_PERP');
    expect(s.positiveFraction).toBe(1);
    expect(s.stableFraction).toBe(1);
    expect(s.harvestableFundingPct).toBeCloseTo(87.6, 1); // 0.0001 × 8760 × 100
    expect(s.breakevenDays).toBeLessThan(1);
    expect(s.harvestable).toBe(true);
    expect(s.annualizedNetPct).toBeGreaterThan(0);
  });

  it('flags a persistently NEGATIVE-funding perp as harvestable via LONG_PERP', () => {
    const s = scoreFundingCarry('BBB', series(200, () => -0.0001), cfg)!;
    expect(s.direction).toBe('LONG_PERP');
    expect(s.positiveFraction).toBe(0);
    expect(s.stableFraction).toBe(1);
    expect(s.harvestableFundingPct).toBeCloseTo(87.6, 1);
    expect(s.harvestable).toBe(true);
    expect(s.annualizedNetPct).toBeGreaterThan(0); // net is positive on the receiving side
  });

  it('rejects a sign-flipping stream (not harvestable — you can not hold one side)', () => {
    const s = scoreFundingCarry('CCC', series(200, (i) => (i % 2 === 0 ? 0.0001 : -0.0001)), cfg)!;
    expect(s.stableFraction).toBeCloseTo(0.5, 2);
    expect(s.harvestable).toBe(false);
  });

  it('rejects a tiny-but-stable funding stream that can not clear the fee in time', () => {
    // 0.0000005/hr ⇒ ~0.44%/yr funding, below the 5% floor + a long breakeven.
    const s = scoreFundingCarry('DDD', series(200, () => 0.0000005), cfg)!;
    expect(s.stableFraction).toBe(1);
    expect(s.harvestableFundingPct).toBeLessThan(5);
    expect(s.harvestable).toBe(false);
  });

  it('returns null on thin history', () => {
    expect(scoreFundingCarry('EEE', series(10, () => 0.0001), cfg)).toBeNull();
  });

  it('applies the liquidity floor when configured', () => {
    const liqCfg = { ...cfg, minDayNtlVlmUsd: 1_000_000 };
    const thin = scoreFundingCarry('FFF', series(200, () => 0.0001), liqCfg, 100)!; // below floor
    expect(thin.liquid).toBe(false);
    expect(thin.harvestable).toBe(false);
    const deep = scoreFundingCarry('GGG', series(200, () => 0.0001), liqCfg, 5_000_000)!;
    expect(deep.liquid).toBe(true);
    expect(deep.harvestable).toBe(true);
  });
});

describe('assembleFundingBoard', () => {
  it('ranks by harvestable funding and pulls out the harvestable set', () => {
    const scored: FundingCarryScore[] = [
      scoreFundingCarry('LOW', series(200, () => 0.00002), cfg)!, // ~17.5%/yr, harvestable
      scoreFundingCarry('HIGH', series(200, () => 0.0002), cfg)!, // ~175%/yr, harvestable
      scoreFundingCarry('FLIP', series(200, (i) => (i % 2 ? -0.0001 : 0.0001)), cfg)!, // not
    ];
    const board = assembleFundingBoard(scored, 50);
    expect(board.universeSize).toBe(50);
    expect(board.scored).toBe(3);
    expect(board.instruments[0].symbol).toBe('HIGH'); // biggest harvestable funding first
    expect(board.harvestable).toBe(2);
    expect(board.carries.map((c) => c.symbol)).toEqual(['HIGH', 'LOW']);
  });
});
