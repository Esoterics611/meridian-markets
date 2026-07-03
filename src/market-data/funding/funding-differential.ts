import { FundingPoint } from './funding-source.interface';

// Cross-venue funding differential (PROFIT_PIVOT_II E4/R4/M2) — the same perp on two
// venues can pay DIFFERENT funding (venue clienteles differ). Short the perp on the
// venue that pays more, long it on the venue that pays less: delta ≈ 0 to the
// underlying (both legs are the same asset), no spot leg, no borrow — the cleanest
// spread in the plan. What remains is the DIFFERENTIAL stream vs the 4-fill
// round-trip cost (maker-routed via E2) and perp-vs-perp basis wiggle.
//
// CADENCE HONESTY: HL settles hourly, Binance/Bybit every 8h (and Bybit varies it
// per symbol) — so raw per-settlement rates are NOT comparable. Everything here is
// aligned on UTC-DAY SUMS: the total fraction of notional a venue's funding paid
// that day. Days present on both venues form the overlap; the differential series
// is dailyA − dailyB on those days. Mean × 365 = the annualised differential; the
// sign-stability fraction says whether it is a persistent clientele effect or noise.
//
// This module is the MEASUREMENT for M2 (the plan: measure ≥1 week before trading).
// Pure + deterministic; the board script feeds it real series.

export interface VenueFundingSeries {
  venue: string;
  points: FundingPoint[];
}

/** Sum funding rates per UTC day → Map<'YYYY-MM-DD', fraction-of-notional that day>. */
export function dailyFundingSums(points: FundingPoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of points) {
    const day = new Date(p.fundingTimeMs).toISOString().slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + p.fundingRate);
  }
  return out;
}

export interface DifferentialConfig {
  /** Per-side fee on venue A / venue B, bps (maker via E2; a rebate is negative). */
  feeBpsA: number;
  feeBpsB: number;
  /** Require at least this many common UTC days to judge (skip thin overlaps). */
  minOverlapDays: number;
  /** |annualised differential| floor, percent. */
  minAnnualizedPct: number;
  /** Fraction of overlap days whose differential matches the mean's sign. */
  minStableFraction: number;
  /** Breakeven hold ceiling, days. */
  maxBreakevenDays: number;
}

export interface FundingDifferentialScore {
  symbol: string;
  venueA: string;
  venueB: string;
  overlapDays: number;
  /** Each venue's own annualised funding over the overlap (context for the spread). */
  annualizedAPct: number;
  annualizedBPct: number;
  /** Mean daily (A − B), annualised, signed percent — the harvestable stream. */
  annualizedDiffPct: number;
  /** Short the venue that pays more; the receiving side of the differential. */
  direction: 'SHORT_A_LONG_B' | 'SHORT_B_LONG_A';
  /** Fraction of overlap days on the mean's side of zero. */
  stableFraction: number;
  /** 4-fill round trip: 2 sides on each venue, bps. */
  roundTripFeeBps: number;
  breakevenDays: number;
  /** Clears every gate: overlap, material, stable, breakeven. */
  harvestable: boolean;
}

/**
 * Score one symbol's cross-venue differential from the two venues' funding series.
 * Returns null when the day-overlap is too thin to judge (skip, don't guess).
 */
export function scoreFundingDifferential(
  symbol: string,
  a: VenueFundingSeries,
  b: VenueFundingSeries,
  cfg: DifferentialConfig,
): FundingDifferentialScore | null {
  const dailyA = dailyFundingSums(a.points);
  const dailyB = dailyFundingSums(b.points);
  const days = [...dailyA.keys()].filter((d) => dailyB.has(d)).sort();
  if (days.length < cfg.minOverlapDays) return null;

  const diffs = days.map((d) => (dailyA.get(d) ?? 0) - (dailyB.get(d) ?? 0));
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  const meanA = days.reduce((s, d) => s + (dailyA.get(d) ?? 0), 0) / days.length;
  const meanB = days.reduce((s, d) => s + (dailyB.get(d) ?? 0), 0) / days.length;
  const stableFraction = diffs.length > 0 ? diffs.filter((x) => (mean >= 0 ? x >= 0 : x < 0)).length / diffs.length : 0;

  const roundTripFeeBps = 2 * (cfg.feeBpsA + cfg.feeBpsB);
  const breakevenDays = Math.abs(mean) > 0 ? roundTripFeeBps / 10_000 / Math.abs(mean) : Infinity;
  const annualizedDiffPct = mean * 365 * 100;
  const harvestable =
    Math.abs(annualizedDiffPct) >= cfg.minAnnualizedPct &&
    stableFraction >= cfg.minStableFraction &&
    breakevenDays <= cfg.maxBreakevenDays;

  return {
    symbol,
    venueA: a.venue,
    venueB: b.venue,
    overlapDays: days.length,
    annualizedAPct: meanA * 365 * 100,
    annualizedBPct: meanB * 365 * 100,
    annualizedDiffPct,
    direction: mean >= 0 ? 'SHORT_A_LONG_B' : 'SHORT_B_LONG_A',
    stableFraction,
    roundTripFeeBps,
    breakevenDays,
    harvestable,
  };
}

export interface FundingDifferentialBoard {
  generatedAt: string;
  scored: number;
  harvestable: number;
  /** All scored pairs, biggest |differential| first. */
  pairs: FundingDifferentialScore[];
}

/** Sort by |annualised differential| (desc) and count the harvestable tails. */
export function assembleDifferentialBoard(scores: FundingDifferentialScore[]): FundingDifferentialBoard {
  const pairs = [...scores].sort((x, y) => Math.abs(y.annualizedDiffPct) - Math.abs(x.annualizedDiffPct));
  return {
    generatedAt: new Date().toISOString(),
    scored: pairs.length,
    harvestable: pairs.filter((p) => p.harvestable).length,
    pairs,
  };
}
