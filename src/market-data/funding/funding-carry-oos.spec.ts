import { FundingPoint } from './funding-source.interface';
import { oosCarryGate, rankCarryUniverse, OosGateConfig } from './funding-carry-oos';

// Pure unit tests — no network, no DB.

const HOUR_MS = 3_600_000;
const BASE_CFG: OosGateConfig = {
  periodsPerYear: 24 * 365,  // HL hourly
  spotFeeBps: 4.5,
  perpFeeBps: 2.5,
  notionalUnits: 100_000_000_000n, // $100k
  minPosFrac: 0.65,
};

function makeFunding(n: number, rate: number, sign: 1 | -1 = 1, startMs = 0): FundingPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'BTC',
    fundingTimeMs: startMs + i * HOUR_MS,
    fundingRate: sign * Math.abs(rate),
    markPrice: 0,
  }));
}

describe('oosCarryGate', () => {
  it('returns null when fewer than 6 settlements', () => {
    const funding = makeFunding(5, 0.0001);
    expect(oosCarryGate('BTC', funding, BASE_CFG)).toBeNull();
  });

  it('passes gate when both windows are persistently positive', () => {
    // 120 hourly settlements all positive = very stable
    const funding = makeFunding(120, 0.0001);
    const result = oosCarryGate('BTC', funding, BASE_CFG);
    expect(result).not.toBeNull();
    expect(result!.passGate).toBe(true);
    expect(result!.direction).toBe('SHORT_PERP');
    expect(result!.inSample.posFrac).toBe(1);
    expect(result!.oos.posFrac).toBe(1);
  });

  it('fails gate when OOS funding flips direction', () => {
    // Train: 80 positive; OOS: 40 negative — classic in-sample-only signal
    const train = makeFunding(80, 0.0001, 1);
    const oos = makeFunding(40, 0.0001, -1, 80 * HOUR_MS);
    const funding = [...train, ...oos];
    const result = oosCarryGate('BTC', funding, BASE_CFG);
    expect(result).not.toBeNull();
    expect(result!.passGate).toBe(false);
  });

  it('passes gate for persistently negative funding (LONG_PERP direction)', () => {
    // All negative — direction is LONG_PERP, should pass
    const funding = makeFunding(120, 0.0001, -1);
    const result = oosCarryGate('BTC', funding, BASE_CFG);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG_PERP');
    expect(result!.passGate).toBe(true);
  });

  it('fails gate when posFrac is below minPosFrac in either window', () => {
    // 50/50 split = unstable, below the 0.65 threshold
    const funding = Array.from({ length: 100 }, (_, i) => ({
      symbol: 'ETH',
      fundingTimeMs: i * HOUR_MS,
      fundingRate: i % 2 === 0 ? 0.0001 : -0.0001, // alternating
      markPrice: 0,
    }));
    const result = oosCarryGate('ETH', funding, BASE_CFG);
    expect(result).not.toBeNull();
    expect(result!.passGate).toBe(false);
  });

  it('computes breakeven correctly for a known rate', () => {
    // BTC HL hourly: meanRate = 0.0001/hr, roundTripFee = 2*(4.5+2.5)/10000 = 0.0014
    // periodsPerDay = 24, dailyFunding = 0.0001*24 = 0.0024
    // breakeven = 0.0014 / 0.0024 ≈ 0.583 days
    const funding = makeFunding(240, 0.0001);
    const result = oosCarryGate('BTC', funding, BASE_CFG);
    expect(result).not.toBeNull();
    expect(result!.full.breakevenDays).toBeCloseTo(0.583, 1);
  });

  it('splits at trainFraction boundary (default 2/3)', () => {
    const funding = makeFunding(120, 0.0001);
    const result = oosCarryGate('BTC', funding, BASE_CFG);
    expect(result).not.toBeNull();
    // 2/3 of 120 = 80 in-sample, 40 OOS
    expect(result!.inSample.periods).toBe(80);
    expect(result!.oos.periods).toBe(40);
  });

  it('respects custom trainFraction', () => {
    const funding = makeFunding(100, 0.0001);
    const result = oosCarryGate('BTC', funding, { ...BASE_CFG, trainFraction: 0.5 });
    expect(result).not.toBeNull();
    expect(result!.inSample.periods).toBe(50);
    expect(result!.oos.periods).toBe(50);
  });

  it('returns null when OOS window would be fewer than 3 settlements', () => {
    // 10 total, trainFraction = 0.99 → OOS = 0 or 1 → null
    const funding = makeFunding(10, 0.0001);
    const result = oosCarryGate('BTC', funding, { ...BASE_CFG, trainFraction: 0.99 });
    expect(result).toBeNull();
  });
});

describe('recency veto (#72 BNB regression)', () => {
  // The BNB case: a long window passes the gate while the CURRENT regime has flipped.
  // 240h of positive funding, then the last 72h negative. With recencyDays=3 the OOS
  // window (last 1/3 ≈ 104h: 32 positive + 72 negative) would FAIL posFrac anyway, so
  // shape it so OOS still clears: 720h positive + last 72h negative → OOS = 264h with
  // 192 positive (posFrac 0.727 ≥ 0.65 passes) — ONLY the veto catches the flip.
  const flipped = [...makeFunding(720, 0.0001, 1), ...makeFunding(72, 0.0001, -1, 720 * HOUR_MS)];

  it('vetoes a symbol whose trailing window flipped against the direction (the BNB case)', () => {
    const result = oosCarryGate('BNB', flipped, { ...BASE_CFG, recencyDays: 3 });
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT_PERP');
    expect(result!.oos.posFrac).toBeGreaterThanOrEqual(0.65); // windows alone would pass…
    expect(result!.recent.vetoed).toBe(true); // …the veto is what catches it
    expect(result!.recent.annualizedFundingPct).toBeLessThan(0);
    expect(result!.passGate).toBe(false);
  });

  it('recencyVeto=false restores the old (pre-#72-fix) behaviour', () => {
    const result = oosCarryGate('BNB', flipped, { ...BASE_CFG, recencyDays: 3, recencyVeto: false });
    expect(result).not.toBeNull();
    expect(result!.recent.vetoed).toBe(false);
    expect(result!.passGate).toBe(true);
  });

  it('mirrors for LONG_PERP: persistently negative funding whose trailing window turned positive', () => {
    const funding = [...makeFunding(720, 0.0001, -1), ...makeFunding(72, 0.0001, 1, 720 * HOUR_MS)];
    const result = oosCarryGate('X', funding, { ...BASE_CFG, recencyDays: 3 });
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG_PERP');
    expect(result!.recent.vetoed).toBe(true);
    expect(result!.passGate).toBe(false);
  });

  it('does not veto a healthy carry, and reports the trailing read (signed by direction)', () => {
    const steady = oosCarryGate('ETH', makeFunding(720, 0.0001), { ...BASE_CFG })!;
    expect(steady.recent.vetoed).toBe(false);
    expect(steady.passGate).toBe(true);
    expect(steady.recent.meanRatePerPeriod).toBeCloseTo(0.0001, 10);
    // 0.0001/h × 8760 × 100 = +87.6%/yr — the side is being paid.
    expect(steady.recent.annualizedFundingPct).toBeCloseTo(87.6, 1);
    // Trailing window: default 7d of hourly points = 168 periods.
    expect(steady.recent.periods).toBe(7 * 24 + 1); // cutoff is inclusive at exactly 7d back
    // LONG_PERP mirror: all-negative funding → the long side EARNS, reported positive.
    const longSide = oosCarryGate('N', makeFunding(720, 0.0001, -1), { ...BASE_CFG })!;
    expect(longSide.recent.vetoed).toBe(false);
    expect(longSide.recent.annualizedFundingPct).toBeCloseTo(87.6, 1);
  });

  it('veto weighs magnitude, not just sign-counts: few large adverse settlements outweigh many tiny favourable ones', () => {
    // Trailing 3d: 60h at +0.00001 (tiny) + 12h at −0.0005 (large) → mean negative ⇒ veto,
    // even though positive settlements are the majority in the window.
    const funding = [
      ...makeFunding(720, 0.0001, 1),
      ...makeFunding(60, 0.00001, 1, 720 * HOUR_MS),
      ...makeFunding(12, 0.0005, -1, 780 * HOUR_MS),
    ];
    const result = oosCarryGate('Y', funding, { ...BASE_CFG, recencyDays: 3 });
    expect(result).not.toBeNull();
    expect(result!.recent.vetoed).toBe(true);
    expect(result!.passGate).toBe(false);
  });
});

describe('rankCarryUniverse', () => {
  it('ranks by annualizedFundingPct descending', () => {
    const histories = [
      { symbol: 'LOW', funding: makeFunding(100, 0.00005) },   // lower rate
      { symbol: 'HIGH', funding: makeFunding(100, 0.0002) },   // higher rate
      { symbol: 'MID', funding: makeFunding(100, 0.0001) },
    ];
    const ranked = rankCarryUniverse(histories, BASE_CFG);
    const symbols = ranked.map((r) => r.symbol);
    expect(symbols[0]).toBe('HIGH');
    expect(symbols[symbols.length - 1]).toBe('LOW');
  });

  it('filters out symbols with too few settlements', () => {
    const histories = [
      { symbol: 'THIN', funding: makeFunding(5, 0.0001) },
      { symbol: 'OK', funding: makeFunding(100, 0.0001) },
    ];
    const ranked = rankCarryUniverse(histories, BASE_CFG);
    expect(ranked.map((r) => r.symbol)).not.toContain('THIN');
    expect(ranked.map((r) => r.symbol)).toContain('OK');
  });

  it('returns empty array for empty input', () => {
    expect(rankCarryUniverse([], BASE_CFG)).toEqual([]);
  });
});
