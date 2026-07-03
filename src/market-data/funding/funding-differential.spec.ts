import { FundingPoint } from './funding-source.interface';
import { assembleDifferentialBoard, dailyFundingSums, DifferentialConfig, scoreFundingDifferential } from './funding-differential';

// Pure specs — the cadence-alignment honesty is the whole point: an hourly venue and
// an 8h venue must be compared on UTC-DAY SUMS, never per-settlement rates.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `perDay` settlements a day at `rate` each, for `days` days starting at epoch day 0. */
function series(symbol: string, days: number, perDay: number, rate: number, startDay = 0): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (let d = startDay; d < startDay + days; d++) {
    for (let i = 0; i < perDay; i++) {
      out.push({ symbol, fundingTimeMs: d * DAY + (i * DAY) / perDay, fundingRate: rate, markPrice: 0 });
    }
  }
  return out;
}

const CFG: DifferentialConfig = {
  feeBpsA: 2,
  feeBpsB: 2,
  minOverlapDays: 5,
  minAnnualizedPct: 3,
  minStableFraction: 0.7,
  maxBreakevenDays: 20,
};

describe('dailyFundingSums', () => {
  it('sums settlements into UTC-day buckets', () => {
    const sums = dailyFundingSums(series('BTC', 2, 3, 0.0002)); // 3×2bp per day
    expect(sums.size).toBe(2);
    expect(sums.get('1970-01-01')).toBeCloseTo(0.0006, 10);
    expect(sums.get('1970-01-02')).toBeCloseTo(0.0006, 10);
  });
});

describe('scoreFundingDifferential — cadence alignment', () => {
  it('an hourly venue vs an 8h venue compares on daily sums, not per-settlement rates', () => {
    // A: 1bp/h × 24 = 24bp/day. B: 2bp per 8h × 3 = 6bp/day. Differential = 18bp/day.
    const a = { venue: 'hyperliquid', points: series('BTC', 10, 24, 0.0001) };
    const b = { venue: 'bybit', points: series('BTC', 10, 3, 0.0002) };
    const s = scoreFundingDifferential('BTC', a, b, CFG);
    expect(s).not.toBeNull();
    expect(s!.overlapDays).toBe(10);
    expect(s!.annualizedAPct).toBeCloseTo(0.0024 * 365 * 100, 5); // 87.6%
    expect(s!.annualizedBPct).toBeCloseTo(0.0006 * 365 * 100, 5); // 21.9%
    expect(s!.annualizedDiffPct).toBeCloseTo(0.0018 * 365 * 100, 5); // 65.7%
    expect(s!.direction).toBe('SHORT_A_LONG_B'); // A pays more ⇒ receive it there
    expect(s!.stableFraction).toBe(1);
    expect(s!.roundTripFeeBps).toBe(8); // 4 maker fills at 2bps
    expect(s!.breakevenDays).toBeCloseTo(0.0008 / 0.0018, 5);
    expect(s!.harvestable).toBe(true);
  });

  it('mirrors direction when B pays more', () => {
    const a = { venue: 'hyperliquid', points: series('BTC', 8, 24, 0.00001) };
    const b = { venue: 'bybit', points: series('BTC', 8, 3, 0.0003) };
    const s = scoreFundingDifferential('BTC', a, b, CFG)!;
    expect(s.annualizedDiffPct).toBeLessThan(0);
    expect(s.direction).toBe('SHORT_B_LONG_A');
  });

  it('only common days count toward the overlap', () => {
    const a = { venue: 'hl', points: series('BTC', 10, 24, 0.0001) };
    const b = { venue: 'bybit', points: series('BTC', 6, 3, 0.0002, 4) }; // days 4..9
    const s = scoreFundingDifferential('BTC', a, b, CFG)!;
    expect(s.overlapDays).toBe(6);
  });

  it('returns null on a too-thin overlap (skip, never guess)', () => {
    const a = { venue: 'hl', points: series('BTC', 3, 24, 0.0001) };
    const b = { venue: 'bybit', points: series('BTC', 3, 3, 0.0002) };
    expect(scoreFundingDifferential('BTC', a, b, CFG)).toBeNull();
  });

  it('a sub-fee differential is not harvestable (breakeven past the cap)', () => {
    // 0.24bp/day differential vs an 8bp round trip ⇒ ~33d breakeven.
    const a = { venue: 'hl', points: series('BTC', 10, 24, 0.00000042) };
    const b = { venue: 'bybit', points: series('BTC', 10, 3, 0) };
    const s = scoreFundingDifferential('BTC', a, b, CFG)!;
    expect(s.breakevenDays).toBeGreaterThan(CFG.maxBreakevenDays);
    expect(s.harvestable).toBe(false);
  });

  it('an unstable (sign-flipping) differential fails the stability gate', () => {
    // Alternate the daily sign: +2bp/day, then −2bp/day — mean ≈ +tiny, stability ≈ 0.5.
    const points: FundingPoint[] = [];
    for (let d = 0; d < 10; d++) points.push({ symbol: 'BTC', fundingTimeMs: d * DAY, fundingRate: d % 2 === 0 ? 0.00021 : -0.0002, markPrice: 0 });
    const a = { venue: 'hl', points };
    const b = { venue: 'bybit', points: series('BTC', 10, 1, 0) };
    const s = scoreFundingDifferential('BTC', a, b, CFG)!;
    expect(s.stableFraction).toBeLessThan(CFG.minStableFraction);
    expect(s.harvestable).toBe(false);
  });
});

describe('assembleDifferentialBoard', () => {
  it('ranks by |annualised differential| and counts the harvestable tails', () => {
    const a = { venue: 'hl', points: series('X', 10, 24, 0.0001) };
    const b = { venue: 'bybit', points: series('X', 10, 3, 0.0002) };
    const big = scoreFundingDifferential('X', a, b, CFG)!;
    const small = scoreFundingDifferential('Y', { venue: 'hl', points: series('Y', 10, 24, 0.000001) }, { venue: 'bybit', points: series('Y', 10, 3, 0) }, CFG)!;
    const board = assembleDifferentialBoard([small, big]);
    expect(board.pairs[0].symbol).toBe('X');
    expect(board.scored).toBe(2);
    expect(board.harvestable).toBe(1);
  });
});
