import { FillSide } from '../inventory/inventory-book';

// FillCostModel — the pluggable execution-cost model for the regime desk's paper fills
// (Playbook II P7). Frictionless mid-fills overstate the edge: a taker never executes at the
// mid. This worsens the fill price so the realised P&L is credible. It mirrors the
// HistoricalReplayVenue cost math (half-spread + linear impact), kept here as a small pure
// model the book can be constructed with — default OFF (NoSlippageModel = today's mid-fill),
// callers opt in to honest costs.
//
// Two adverse components, charged on BOTH entry and exit legs (BUY fills above the mid, SELL
// below): the half-spread (the cost of crossing the bid-ask, bps of price) and a linear market
// impact (bps of price per $1M of notional, so bigger size pays more). The fill price is the
// honest cost — it lands in realised/unrealised via the avg-cost ledger — while the book also
// tracks the slippage MAGNITUDE separately for TCA (P10).

const MICROS = 1_000_000n;
/** Max adverse fill move, so a pathological size can't produce an absurd price. */
const MAX_ADVERSE_FRAC = 0.05; // 500 bps

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export interface FillCostModel {
  /** The executed taker price (micros), worsened from the fair mid by half-spread + impact. */
  fillPrice(side: FillSide, sizeUnits: bigint, midMicros: bigint): bigint;
}

/** Frictionless: fills exactly at the mid — today's behaviour, the safe default (no regression). */
export class NoSlippageModel implements FillCostModel {
  fillPrice(_side: FillSide, _sizeUnits: bigint, midMicros: bigint): bigint {
    return midMicros;
  }
}

export interface SlippageImpactConfig {
  /** Half the bid-ask spread, bps of price — the cost of crossing on a taker fill. */
  halfSpreadBps: number;
  /** Linear market impact, bps of price per $1M of notional traded. Default 0. */
  impactBpsPerMillionUsd?: number;
}

/** Half-spread + linear-in-notional impact. BUY fills above the mid, SELL below. */
export class SlippageImpactModel implements FillCostModel {
  private readonly halfSpreadFrac: number;
  private readonly impactPerMm: number; // fraction of price per $1M of notional

  constructor(cfg: SlippageImpactConfig) {
    this.halfSpreadFrac = Math.max(0, cfg.halfSpreadBps) / 10_000;
    this.impactPerMm = Math.max(0, cfg.impactBpsPerMillionUsd ?? 0) / 10_000;
  }

  fillPrice(side: FillSide, sizeUnits: bigint, midMicros: bigint): bigint {
    if (sizeUnits === 0n || midMicros <= 0n) return midMicros;
    const notionalUsd = Number((bigAbs(sizeUnits) * midMicros) / MICROS) / 1_000_000; // USDC-units → USD
    const notionalMm = notionalUsd / 1_000_000; // → $millions
    const adverse = Math.min(this.halfSpreadFrac + this.impactPerMm * notionalMm, MAX_ADVERSE_FRAC);
    const factor = side === 'BUY' ? 1 + adverse : 1 - adverse;
    return BigInt(Math.round(Number(midMicros) * factor));
  }
}

/** The slippage cost (USDC-units, ≥ 0) of executing `sizeUnits` at `fillPriceMicros` vs the mid. */
export function slippageCostUnits(sizeUnits: bigint, midMicros: bigint, fillPriceMicros: bigint): bigint {
  const diff = fillPriceMicros >= midMicros ? fillPriceMicros - midMicros : midMicros - fillPriceMicros;
  return (bigAbs(sizeUnits) * diff) / MICROS;
}
