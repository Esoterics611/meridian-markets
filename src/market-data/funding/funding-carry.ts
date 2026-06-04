import { FundingPoint } from './funding-source.interface';

// funding-carry — the P&L model for a delta-neutral cash-and-carry on a perp:
// LONG spot + SHORT perp, held over a window. Three P&L sources, all modelled:
//
//   1. funding harvested — the short-perp leg RECEIVES funding each settlement
//      when fundingRate > 0 (and PAYS when < 0). This is the carry / the edge.
//   2. basis P&L — the position is delta-neutral, so directional price moves wash
//      out; what's left is the change in the perp-vs-spot basis over the hold
//      (you keep (spotExit/spotEntry) − (perpExit/perpEntry) on the notional).
//   3. fees — a round trip is FOUR taker fills (spot in/out + perp in/out).
//
// net = funding + basis − fees. Same honesty bar as the rest of the desk: the
// dominant cost is the round-trip fee, so carry only pays if the funding earned
// over the hold clears it — the funding analogue of "fee drag dominates a thin
// per-trade edge". Pure + deterministic; the research harness and any future live
// path compute P&L identically. Money is bigint USDC-units (6-dec); rates floats.

const BINANCE_PERIODS_PER_YEAR = (365 * 24) / 8; // Binance settles funding every 8h

export interface CarryInputs {
  /** Funding settlements realised during the hold, chronological. */
  funding: FundingPoint[];
  spotEntry: number;
  spotExit: number;
  perpEntry: number;
  perpExit: number;
  /** Per-leg notional, USDC-units (6-dec). Spot and perp legs are equal-notional. */
  notionalUnits: bigint;
  /** Taker fee per side, bps of notional. */
  spotFeeBps: number;
  perpFeeBps: number;
  /**
   * Settlements per year for THIS venue (annualisation + trailing-interval days).
   * Binance USDⓈ-M = (365×24)/8 = 1095 (8h); Hyperliquid = 8760 (HOURLY). Defaults
   * to the Binance 8h cadence so existing callers are unchanged.
   */
  periodsPerYear?: number;
}

export interface CarryResult {
  periods: number;
  windowDays: number;
  /** + = the short-perp leg earned funding over the hold. */
  fundingCollectedUnits: bigint;
  /** Delta-neutral price P&L = basis convergence over the hold. */
  basisPnlUnits: bigint;
  /** Round-trip fees, both legs (always a cost, ≥ 0). */
  feesUnits: bigint;
  netUnits: bigint;
  /** Mean funding rate per 8h settlement over the window. */
  meanFundingPerPeriod: number;
  /** Funding-only annualised return (gross of fees/basis) = mean × periods/yr. */
  annualizedFundingPct: number;
  /** Net annualised return on one leg's notional. */
  annualizedNetPct: number;
  /** Fraction of settlements with funding > 0 (carry-direction stability). */
  positiveFraction: number;
}

function round(x: number): bigint {
  return BigInt(Math.round(x));
}

/** Static delta-neutral cash-and-carry over the full funding window. */
export function staticCarry(inp: CarryInputs): CarryResult {
  const notional = Number(inp.notionalUnits);
  const periods = inp.funding.length;
  const periodsPerYear = inp.periodsPerYear ?? BINANCE_PERIODS_PER_YEAR;

  // 1. Funding harvested by the short-perp leg. Funding accrues on the perp's
  //    notional at each settlement = rate · (qty · mark). qty = notional/perpEntry,
  //    so the per-settlement cash flow is rate · notional · (mark/perpEntry). When a
  //    source omits per-settlement mark (HL fundingHistory has none ⇒ markPrice 0),
  //    fall back to markRatio 1 — accrue on the entry notional rather than zeroing
  //    funding outright (the bug a literal mark/perpEntry would cause at mark 0).
  let funding = 0;
  let positive = 0;
  for (const p of inp.funding) {
    const markRatio = inp.perpEntry > 0 && p.markPrice > 0 ? p.markPrice / inp.perpEntry : 1;
    funding += p.fundingRate * notional * markRatio;
    if (p.fundingRate > 0) positive += 1;
  }

  // 2. Basis P&L: long spot return + short perp return on equal notional.
  const spotRet = inp.spotEntry > 0 ? (inp.spotExit - inp.spotEntry) / inp.spotEntry : 0;
  const perpRet = inp.perpEntry > 0 ? (inp.perpExit - inp.perpEntry) / inp.perpEntry : 0;
  const basis = notional * (spotRet - perpRet); // short perp ⇒ −perpRet

  // 3. Round-trip fees: entry + exit on both legs.
  const fees = (notional * 2 * (inp.spotFeeBps + inp.perpFeeBps)) / 10_000;

  const net = funding + basis - fees;

  const firstMs = periods ? inp.funding[0].fundingTimeMs : 0;
  const lastMs = periods ? inp.funding[periods - 1].fundingTimeMs : 0;
  // Hold spans the settlements; +1 interval so a single settlement isn't 0 days. The
  // interval is 365/periodsPerYear days (8h Binance ⇒ 1/3 day; 1h HL ⇒ 1/24 day).
  const intervalDays = 365 / periodsPerYear;
  const windowDays = periods ? (lastMs - firstMs) / 86_400_000 + intervalDays : 0;
  const meanFunding = periods ? inp.funding.reduce((s, p) => s + p.fundingRate, 0) / periods : 0;

  return {
    periods,
    windowDays,
    fundingCollectedUnits: round(funding),
    basisPnlUnits: round(basis),
    feesUnits: round(fees),
    netUnits: round(net),
    meanFundingPerPeriod: meanFunding,
    annualizedFundingPct: meanFunding * periodsPerYear * 100,
    annualizedNetPct: windowDays > 0 && notional > 0 ? (net / notional / windowDays) * 365 * 100 : 0,
    positiveFraction: periods ? positive / periods : 0,
  };
}
