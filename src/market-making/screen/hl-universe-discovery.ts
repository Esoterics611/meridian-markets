import { Bar } from '../../stat-arb/backtest/bar';
import { RollingVolatility } from '../quote/volatility';
import { scoreMmSuitability, MmSuitabilityScore } from './mm-suitability-scorer';

// HL universe MM discovery — "which Hyperliquid perp should we make markets in?"
// The maker's discovery board over the WHOLE HL perp universe, not just the
// BTC/ETH/SOL preset. Two stages:
//
//   1. parseHlUniverse — one `metaAndAssetCtxs` payload → every perp's mark,
//      funding (hourly, signed) and daily $ volume (the liquidity proxy).
//   2. scoreHlPerp — score each (shortlisted) perp with the SAME honest
//      `scoreMmSuitability` the live screener uses: spread + rebate − adverse,
//      fillability-weighted, on OHLCV proxies.
//
// The board surfaces the NON-MAJOR perps worth quoting — the discovery payload,
// the mission's stated growth frontier ("new markets to make markets in").
//
// HONESTY (identical to MmScreener): OHLCV gives no L2 book and no flow tape, so
// `adverseBps ≈ adverseCoef·σ_bar` and `fillProb ≈ (avgRange/2)/halfSpread` are
// PROXIES — they rank instruments sensibly but are NOT a fill forecast. The real
// verdict on the shortlist is the L2 queue-aware capture + γ/κ tune (mm-l2-session
// → mm-l2-tune). Funding is REPORTED (APR + sign) but NOT folded into the score: a
// maker's inventory is involuntary, so funding only helps when its sign aligns with
// the inventory the flow forces on the book — a per-book read, not a ranking input.

/** BTC/ETH/SOL — the perps already in the `hl-perps` preset; discovery looks past them. */
export const HL_MAJORS = new Set(['BTC', 'ETH', 'SOL']);

export interface HlPerpCtx {
  name: string;
  markPx: number;
  /** HL funding is a SIGNED fraction per HOUR (+ ⇒ longs pay shorts). */
  fundingHourly: number;
  /** Daily notional traded volume in USD (HL `dayNtlVlm`) — the liquidity proxy. */
  dayNtlVlmUsd: number;
}

/**
 * Parse a `metaAndAssetCtxs` payload into the FULL list of perp ctxs. The payload
 * is `[ {universe:[{name}]}, [{funding, markPx, oraclePx, dayNtlVlm, ...}] ]` with
 * the two arrays parallel by index (same shape `parseHyperliquidAssetCtxs` reads for
 * one coin; here we keep all of them). Returns [] on a malformed shape.
 */
export function parseHlUniverse(raw: unknown): HlPerpCtx[] {
  const pair = raw as [{ universe?: { name?: string }[] }, Record<string, string>[]] | undefined;
  const universe = pair?.[0]?.universe;
  const ctxs = pair?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return [];
  const out: HlPerpCtx[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i]?.name;
    const ctx = ctxs[i];
    if (!name || !ctx) continue;
    out.push({
      name,
      markPx: safeNum(ctx.markPx ?? ctx.oraclePx),
      fundingHourly: safeNum(ctx.funding),
      dayNtlVlmUsd: safeNum(ctx.dayNtlVlm),
    });
  }
  return out;
}

/** Coerce a string/number/undefined field to a FINITE number (malformed ⇒ 0). */
function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Annualised funding from an hourly rate (HL settles HOURLY ⇒ ×24×365). */
export function fundingAprFromHourly(hourly: number): number {
  return hourly * 24 * 365;
}

export interface HlDiscoveryConfig {
  /** Half-spread we'd post, bps of mid. */
  quoteHalfSpreadBps: number;
  /** Maker fee in bps, SIGNED (HL is a −0.2bps rebate). */
  makerFeeBps: number;
  volWindowBars: number;
  barsPerDay: number;
  /** Adverse selection per fill as a multiple of σ_bar. */
  adverseCoef: number;
  /** Min daily $ volume for a perp to be considered quotable (liquidity floor). */
  minDayNtlVlmUsd: number;
}

export interface HlPerpScore extends MmSuitabilityScore {
  symbol: string;
  isMajor: boolean;
  markPx: number;
  dayNtlVlmUsd: number;
  fundingAprPct: number;
  avgRangeBps: number;
  /** Cleared the liquidity floor (enough daily flow to rest + fill). */
  liquid: boolean;
  /** Cleared the liquidity floor AND the suitability "attractive" gate. */
  quotable: boolean;
}

/**
 * Score one perp's MM suitability from its ctx + recent OHLCV bars. Returns null
 * when there are too few bars to seed the σ window (skip, don't guess).
 */
export function scoreHlPerp(ctx: HlPerpCtx, bars: Bar[], cfg: HlDiscoveryConfig): HlPerpScore | null {
  if (bars.length < cfg.volWindowBars + 1) return null;

  const vol = new RollingVolatility(cfg.volWindowBars);
  let rangeSum = 0;
  let rangeN = 0;
  for (const b of bars) {
    vol.push(b.close);
    if (b.close > 0) {
      rangeSum += ((b.high - b.low) / b.close) * 10_000;
      rangeN += 1;
    }
  }
  const volatility = vol.valueOr(1e-6);
  const avgRangeBps = rangeN > 0 ? rangeSum / rangeN : 0;
  const rebateBps = cfg.makerFeeBps < 0 ? -cfg.makerFeeBps : 0;

  const score = scoreMmSuitability({
    volatility,
    avgRangeBps,
    rebateBps,
    quoteHalfSpreadBps: cfg.quoteHalfSpreadBps,
    barsPerDay: cfg.barsPerDay,
    adverseCoef: cfg.adverseCoef,
  });

  const liquid = ctx.dayNtlVlmUsd >= cfg.minDayNtlVlmUsd;
  return {
    symbol: ctx.name,
    isMajor: HL_MAJORS.has(ctx.name),
    markPx: ctx.markPx,
    dayNtlVlmUsd: ctx.dayNtlVlmUsd,
    fundingAprPct: fundingAprFromHourly(ctx.fundingHourly) * 100,
    avgRangeBps,
    liquid,
    quotable: liquid && score.attractive,
    ...score,
  };
}

export interface HlDiscoveryBoard {
  generatedAt: string;
  universeSize: number;
  scored: number;
  quotable: number;
  /** Quotable perps OUTSIDE BTC/ETH/SOL — the strict discovery payload, best score/day first. */
  discoveries: HlPerpScore[];
  /**
   * Liquid perps ranked by LOWEST 1m σ (least inventory risk) — the actionable
   * MM-candidate shortlist to point the L2 capture at, independent of the fixed-
   * spread "quotable" gate (which is net-negative across volatile perps because the
   * proxy charges full-σ adverse against a fixed tiny spread; the live book quotes a
   * σ-proportional spread, a fill/queue question only the L2 harness resolves).
   */
  calmestLiquid: HlPerpScore[];
  /** Every scored perp, best score/day first. */
  instruments: HlPerpScore[];
  /** Suggested L2-capture symbols (calmest liquid non-majors first, then majors to fill). */
  suggestedPresetSymbols: string[];
}

/** Sort + count; pull out the strict discoveries AND the calmest-liquid shortlist. */
export function assembleDiscoveryBoard(
  scored: HlPerpScore[],
  universeSize: number,
  opts: { maxDiscoveries?: number; maxCalmest?: number } = {},
): HlDiscoveryBoard {
  const instruments = [...scored].sort((a, b) => b.scorePerDayBps - a.scorePerDayBps);
  const discoveries = instruments.filter((i) => i.quotable && !i.isMajor);
  const maxD = opts.maxDiscoveries ?? 8;
  const maxC = opts.maxCalmest ?? 6;
  // The actionable shortlist: liquid perps with the lowest per-bar σ (lowest
  // inventory risk + lowest adverse selection), calmest first.
  const calmestLiquid = instruments.filter((i) => i.liquid).sort((a, b) => a.volBps - b.volBps).slice(0, maxC);
  // Prefer non-major calm perps as the discovery suggestion; if the strict gate is
  // empty (the usual case on volatile perps) fall back to the calmest-liquid list.
  const suggestion = (discoveries.length ? discoveries : calmestLiquid).slice(0, maxD).map((i) => i.symbol);
  return {
    generatedAt: new Date().toISOString(),
    universeSize,
    scored: instruments.length,
    quotable: instruments.filter((i) => i.quotable).length,
    discoveries,
    calmestLiquid,
    instruments,
    suggestedPresetSymbols: suggestion,
  };
}
