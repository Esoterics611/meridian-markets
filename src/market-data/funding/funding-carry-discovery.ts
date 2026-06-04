import { FundingPoint } from './funding-source.interface';
import { staticCarry } from './funding-carry';

// Funding-carry universe discovery — "which perp in the WHOLE universe pays
// persistent, HARVESTABLE funding?" The carry analogue of hl-universe-discovery
// (which ranks MM suitability): here we rank the cross-venue delta-neutral
// cash-and-carry (long spot / short perp, or the reverse for persistently
// negative funding) by the funding STREAM it harvests, net of the one-time
// round-trip fee.
//
// The honesty bar (same as funding-carry-research.ts): the edge is the funding
// stream (continuous); the 4-fill round trip is a ONE-TIME cost — so a coin is
// "harvestable" only when (a) its funding is large enough to matter, (b) its
// SIGN is STABLE (you can't harvest a stream that flips — you'd pay the round
// trip repeatedly), and (c) the breakeven hold is short enough to be realistic.
// Basis P&L is excluded here (delta-neutral, mean-zero entry-timing noise); the
// funding-only read is the discovery signal, the live cross-venue book is the
// verdict. Pure + deterministic; tested with synthetic funding series.

export interface FundingDiscoveryConfig {
  /** Taker fee per side on the spot leg, bps. */
  spotFeeBps: number;
  /** Taker fee per side on the perp leg, bps. */
  perpFeeBps: number;
  /** Settlements per year for the venue (HL hourly = 8760, Binance 8h = 1095). */
  periodsPerYear: number;
  /** Notional for the staticCarry call (cancels in the % metrics; any positive value). */
  notionalUnits: bigint;
  /** Require at least this many settlements of history (skip thin coins, don't guess). */
  minPeriods: number;
  /** Sign-stability floor: max(posFrac, 1−posFrac) must clear this (e.g. 0.6). */
  minStableFraction: number;
  /** A coin is harvestable only if |annualised funding| clears this (percent). */
  minAnnualizedFundingPct: number;
  /** A coin is harvestable only if its breakeven hold is ≤ this many days. */
  maxBreakevenDays: number;
  /** Optional daily $-volume liquidity floor (USD). 0 ⇒ no floor (volume unknown). */
  minDayNtlVlmUsd?: number;
}

/** Which leg RECEIVES the funding stream — the side you'd actually run. */
export type CarryDirection = 'SHORT_PERP' | 'LONG_PERP';

export interface FundingCarryScore {
  symbol: string;
  /** Settlements observed in the window. */
  periods: number;
  windowDays: number;
  /** Signed mean funding per settlement, bps (+ ⇒ longs pay shorts). */
  meanFundingBps: number;
  /** Signed annualised funding (mean × periods/yr × 100). */
  annualizedFundingPct: number;
  /** |annualised funding| — the gross carry you'd HARVEST on the receiving side. */
  harvestableFundingPct: number;
  /** Fraction of settlements with funding > 0. */
  positiveFraction: number;
  /** max(posFrac, 1−posFrac) — how one-signed (harvestable) the stream is. */
  stableFraction: number;
  /** Receiving leg: short perp for + funding, long perp for − funding. */
  direction: CarryDirection;
  /** Days of funding needed to clear the one-time round-trip fee. */
  breakevenDays: number;
  /** Net annualised return on one leg's notional, funding-only (basis excluded). */
  annualizedNetPct: number;
  /** Daily $-volume (USD) when supplied to the scorer (liquidity proxy), else 0. */
  dayNtlVlmUsd: number;
  /** Cleared the liquidity floor (or no floor configured). */
  liquid: boolean;
  /** Cleared every gate: stable sign, material funding, short breakeven, liquid. */
  harvestable: boolean;
}

/**
 * Score one perp's funding-carry from its funding history. Returns null when
 * there are too few settlements to judge (skip, don't guess). `dayNtlVlmUsd` is
 * the optional liquidity proxy from the universe ctx (0 ⇒ unknown).
 */
export function scoreFundingCarry(
  symbol: string,
  funding: FundingPoint[],
  cfg: FundingDiscoveryConfig,
  dayNtlVlmUsd = 0,
): FundingCarryScore | null {
  if (funding.length < cfg.minPeriods) return null;

  // Delta-neutral with flat prices ⇒ basis 0; isolates the funding edge net of
  // the one-time round-trip fee, on the natural (short-perp) carry.
  const res = staticCarry({
    funding,
    spotEntry: 1,
    spotExit: 1,
    perpEntry: 1,
    perpExit: 1,
    notionalUnits: cfg.notionalUnits,
    spotFeeBps: cfg.spotFeeBps,
    perpFeeBps: cfg.perpFeeBps,
    periodsPerYear: cfg.periodsPerYear,
  });

  const meanFunding = res.meanFundingPerPeriod; // signed, per settlement
  const positiveFraction = res.positiveFraction;
  const stableFraction = Math.max(positiveFraction, 1 - positiveFraction);
  const direction: CarryDirection = meanFunding >= 0 ? 'SHORT_PERP' : 'LONG_PERP';
  const harvestableFundingPct = Math.abs(res.annualizedFundingPct);

  // Breakeven: round-trip fee (fraction) / funding harvested per day.
  const roundTripFeeFraction = (2 * (cfg.spotFeeBps + cfg.perpFeeBps)) / 10_000;
  const periodsPerDay = cfg.periodsPerYear / 365;
  const fundingPerDay = Math.abs(meanFunding) * periodsPerDay;
  const breakevenDays = fundingPerDay > 0 ? roundTripFeeFraction / fundingPerDay : Infinity;

  // Net annualised on the receiving side: the natural carry's net flips sign with
  // the direction (funding magnitude is the same; only its sign to the book flips).
  const netUnits = direction === 'SHORT_PERP' ? res.netUnits : -res.fundingCollectedUnits - res.feesUnits;
  const annualizedNetPct =
    res.windowDays > 0 && cfg.notionalUnits > 0n ? (Number(netUnits) / Number(cfg.notionalUnits) / res.windowDays) * 365 * 100 : 0;

  const liquid = !cfg.minDayNtlVlmUsd || dayNtlVlmUsd >= cfg.minDayNtlVlmUsd;
  const harvestable =
    liquid &&
    stableFraction >= cfg.minStableFraction &&
    harvestableFundingPct >= cfg.minAnnualizedFundingPct &&
    breakevenDays <= cfg.maxBreakevenDays;

  return {
    symbol,
    periods: res.periods,
    windowDays: res.windowDays,
    meanFundingBps: meanFunding * 10_000,
    annualizedFundingPct: res.annualizedFundingPct,
    harvestableFundingPct,
    positiveFraction,
    stableFraction,
    direction,
    breakevenDays,
    annualizedNetPct,
    dayNtlVlmUsd,
    liquid,
    harvestable,
  };
}

export interface FundingCarryBoard {
  generatedAt: string;
  universeSize: number;
  scored: number;
  harvestable: number;
  /** Harvestable perps, biggest harvestable funding first — the carry discovery payload. */
  carries: FundingCarryScore[];
  /** Every scored perp, biggest harvestable funding first. */
  instruments: FundingCarryScore[];
}

/** Sort by harvestable funding (desc); pull out the perps that clear every gate. */
export function assembleFundingBoard(scored: FundingCarryScore[], universeSize: number): FundingCarryBoard {
  const instruments = [...scored].sort((a, b) => b.harvestableFundingPct - a.harvestableFundingPct);
  const carries = instruments.filter((i) => i.harvestable);
  return {
    generatedAt: new Date().toISOString(),
    universeSize,
    scored: instruments.length,
    harvestable: carries.length,
    carries,
    instruments,
  };
}
