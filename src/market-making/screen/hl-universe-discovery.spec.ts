import {
  parseHlUniverse,
  fundingAprFromHourly,
  scoreHlPerp,
  assembleDiscoveryBoard,
  HlPerpCtx,
  HlPerpScore,
  HlDiscoveryConfig,
} from './hl-universe-discovery';
import { Bar } from '../../stat-arb/backtest/bar';

// A canned metaAndAssetCtxs payload: the two arrays are parallel by index.
const RAW = [
  { universe: [{ name: 'BTC' }, { name: 'WIF' }, { name: 'TINY' }, { name: 'BAD' }] },
  [
    { funding: '0.0000125', markPx: '63000', oraclePx: '62990', dayNtlVlm: '900000000' }, // BTC, $900M/day
    { funding: '0.00005', markPx: '2.5', oraclePx: '2.49', dayNtlVlm: '40000000' },        // WIF, $40M/day
    { funding: '-0.00002', markPx: '0.01', oraclePx: '0.01', dayNtlVlm: '50000' },          // TINY, $50k/day (illiquid)
    { funding: 'x', markPx: '0' },                                                          // BAD (no vol field)
  ],
];

const CFG: HlDiscoveryConfig = {
  quoteHalfSpreadBps: 2,
  makerFeeBps: -0.2, // HL rebate
  volWindowBars: 5,
  barsPerDay: 24,
  adverseCoef: 0.5,
  minDayNtlVlmUsd: 5_000_000, // $5M/day liquidity floor
};

function bars(symbol: string, closes: number[], rangeFrac = 0.002): Bar[] {
  return closes.map((c, i) => ({
    symbol,
    timestamp: new Date(2026, 0, 1, i),
    open: c,
    high: c * (1 + rangeFrac),
    low: c * (1 - rangeFrac),
    close: c,
    volume: 1,
  }));
}

// A calm, low-vol close series (tiny drift) — low inventory risk for a maker.
const CALM = [100, 100.02, 99.99, 100.01, 100.0, 100.02, 99.98, 100.01];
// A choppy, high-vol series (±1% steps) — higher σ_bar, more adverse selection.
const CHOPPY = [100, 101, 99, 101, 99, 101, 99, 101];

describe('parseHlUniverse', () => {
  it('parses every coin in the parallel arrays into a ctx', () => {
    const u = parseHlUniverse(RAW);
    expect(u.map((c) => c.name)).toEqual(['BTC', 'WIF', 'TINY', 'BAD']);
    const wif = u.find((c) => c.name === 'WIF')!;
    expect(wif.markPx).toBe(2.5);
    expect(wif.fundingHourly).toBeCloseTo(0.00005);
    expect(wif.dayNtlVlmUsd).toBe(40_000_000);
  });

  it('falls back to oraclePx and 0 volume when fields are missing', () => {
    const bad = parseHlUniverse(RAW).find((c) => c.name === 'BAD')!;
    expect(bad.markPx).toBe(0);
    expect(bad.dayNtlVlmUsd).toBe(0);
    expect(bad.fundingHourly).toBe(0); // 'x' → NaN → coerced to 0 via Number('x')? guard
  });

  it('returns [] on a malformed shape', () => {
    expect(parseHlUniverse(null)).toEqual([]);
    expect(parseHlUniverse([{}, 'nope'])).toEqual([]);
  });
});

describe('fundingAprFromHourly', () => {
  it('annualises an hourly rate over 24×365 hours', () => {
    expect(fundingAprFromHourly(0.0000125)).toBeCloseTo(0.0000125 * 8760);
  });
});

describe('scoreHlPerp', () => {
  const ctx = (over: Partial<HlPerpCtx> = {}): HlPerpCtx => ({
    name: 'WIF', markPx: 2.5, fundingHourly: 0.00005, dayNtlVlmUsd: 40_000_000, ...over,
  });

  it('returns null when there are too few bars to seed σ', () => {
    expect(scoreHlPerp(ctx(), bars('WIF', [1, 2, 3]), CFG)).toBeNull();
  });

  it('scores a calm liquid perp as quotable and reports funding APR', () => {
    const s = scoreHlPerp(ctx(), bars('WIF', CALM), CFG)!;
    expect(s.symbol).toBe('WIF');
    expect(s.isMajor).toBe(false);
    expect(s.quotable).toBe(true); // liquid + attractive
    expect(s.fundingAprPct).toBeCloseTo(0.00005 * 8760 * 100);
    expect(s.scorePerDayBps).toBeGreaterThan(0);
  });

  it('marks an illiquid perp NOT quotable even if the suitability score is positive', () => {
    const s = scoreHlPerp(ctx({ name: 'TINY', dayNtlVlmUsd: 50_000 }), bars('TINY', CALM), CFG)!;
    expect(s.attractive).toBe(true);   // the OHLCV suitability is fine
    expect(s.liquid).toBe(false);      // below the liquidity floor
    expect(s.quotable).toBe(false);    // ⇒ not quotable
  });

  it('sets liquid=true for a perp above the volume floor', () => {
    expect(scoreHlPerp(ctx({ dayNtlVlmUsd: 40_000_000 }), bars('WIF', CALM), CFG)!.liquid).toBe(true);
  });

  it('flags BTC/ETH/SOL as majors', () => {
    expect(scoreHlPerp(ctx({ name: 'BTC' }), bars('BTC', CALM), CFG)!.isMajor).toBe(true);
  });
});

describe('assembleDiscoveryBoard', () => {
  it('sorts by score/day, isolates non-major quotable discoveries, and suggests a preset', () => {
    const scored: HlPerpScore[] = [
      scoreHlPerp({ name: 'BTC', markPx: 63000, fundingHourly: 0, dayNtlVlmUsd: 9e8 }, bars('BTC', CALM), CFG)!,
      scoreHlPerp({ name: 'WIF', markPx: 2.5, fundingHourly: 5e-5, dayNtlVlmUsd: 4e7 }, bars('WIF', CALM), CFG)!,
      scoreHlPerp({ name: 'TINY', markPx: 0.01, fundingHourly: 0, dayNtlVlmUsd: 5e4 }, bars('TINY', CALM), CFG)!,
    ];
    const board = assembleDiscoveryBoard(scored, 200, { maxDiscoveries: 5 });
    expect(board.universeSize).toBe(200);
    expect(board.scored).toBe(3);
    // BTC is quotable but a major; TINY is non-major but illiquid → only WIF is a discovery.
    expect(board.discoveries.map((d) => d.symbol)).toEqual(['WIF']);
    expect(board.suggestedPresetSymbols).toEqual(['WIF']);
    // Sorted best-first across all instruments.
    const scores = board.instruments.map((i) => i.scorePerDayBps);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('caps the suggested preset at maxDiscoveries', () => {
    const many: HlPerpScore[] = ['AAA', 'BBB', 'CCC', 'DDD'].map(
      (n) => scoreHlPerp({ name: n, markPx: 1, fundingHourly: 0, dayNtlVlmUsd: 4e7 }, bars(n, CALM), CFG)!,
    );
    const board = assembleDiscoveryBoard(many, 50, { maxDiscoveries: 2 });
    expect(board.discoveries.length).toBe(4);
    expect(board.suggestedPresetSymbols.length).toBe(2);
  });

  it('calmestLiquid ranks liquid perps by lowest σ and drops the illiquid', () => {
    const scored: HlPerpScore[] = [
      scoreHlPerp({ name: 'CHOP', markPx: 1, fundingHourly: 0, dayNtlVlmUsd: 4e7 }, bars('CHOP', CHOPPY), CFG)!,
      scoreHlPerp({ name: 'CALMC', markPx: 1, fundingHourly: 0, dayNtlVlmUsd: 4e7 }, bars('CALMC', CALM), CFG)!,
      scoreHlPerp({ name: 'TINY', markPx: 1, fundingHourly: 0, dayNtlVlmUsd: 5e4 }, bars('TINY', CALM), CFG)!,
    ];
    const board = assembleDiscoveryBoard(scored, 100, { maxCalmest: 6 });
    // Calmest first, illiquid TINY excluded.
    expect(board.calmestLiquid.map((i) => i.symbol)).toEqual(['CALMC', 'CHOP']);
  });

  it('falls back to the calmest-liquid shortlist when no strict discovery clears the gate', () => {
    // Both liquid majors → no non-major discovery; suggestion must fall back.
    const scored: HlPerpScore[] = [
      scoreHlPerp({ name: 'BTC', markPx: 63000, fundingHourly: 0, dayNtlVlmUsd: 9e8 }, bars('BTC', CHOPPY), CFG)!,
      scoreHlPerp({ name: 'ETH', markPx: 1800, fundingHourly: 0, dayNtlVlmUsd: 5e8 }, bars('ETH', CALM), CFG)!,
    ];
    const board = assembleDiscoveryBoard(scored, 100);
    expect(board.discoveries).toEqual([]);
    expect(board.suggestedPresetSymbols).toEqual(board.calmestLiquid.map((i) => i.symbol));
    expect(board.suggestedPresetSymbols[0]).toBe('ETH'); // the calmer major first
  });
});
