import { IQuoter } from './quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from './quote-pair';
import { clamp, railHalfSpread, asReservationMicros, asHalfSpreadMicros } from './avellaneda-stoikov';
import { GlftQuoterParams } from './glft-quoter';

// DirectionalGlftQuoter — the "axed" market maker (DIRECTIONAL_MM_STRATEGY.md).
//
// A neutral GLFT book skews its reservation to shed inventory toward ZERO,
// treating any held position as pure risk. But the 6h/8h L2 harvests (Journal
// #27–#32) showed inventory CARRY is the dominant P&L term and the only thing
// still losing once the spread edge went positive at fine cadence. So where the
// desk holds a directional VIEW, we don't fight the carry — we CHOOSE it: rest
// the book at a non-zero TARGET inventory aligned with the view, recycling spread
// around it. The maker then earns spread + rebate WHILE building the position at
// better-than-mid prices (a maker-financed, cushioned directional bet — the real
// dealer "axe").
//
// The only change vs GLFT is the skew TARGET: q* = bias·maxInventoryLots instead
// of 0. The reservation skews toward q* (so at inventory == q* it quotes
// symmetrically and holds), and an optional conviction drift tilts the center
// toward the view so it fills slightly more on the view side even at target.
// bias = 0 reproduces GlftQuoter exactly (the swap-seam default).

export interface DirectionalGlftParams extends GlftQuoterParams {
  /** House-view bias in [−1, +1]: +1 = max long target, −1 = max short, 0 = neutral GLFT. */
  bias: number;
  /** Conviction-to-edge gain: extra outright center drift = bias·gain·σ·price. Default 0. */
  convictionGain?: number;
}

function bigMax1(x: bigint): bigint {
  return x > 1n ? x : 1n;
}

export class DirectionalGlftQuoter implements IQuoter {
  readonly familyId = 'directional-glft';
  private tickSeq = 0;
  private readonly lotUnits: bigint;
  private readonly bias: number;
  private readonly convictionGain: number;

  constructor(
    private readonly p: DirectionalGlftParams,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.lotUnits = p.inventoryLotUnits && p.inventoryLotUnits > 0n ? p.inventoryLotUnits : p.quoteSizeUnits;
    this.bias = clamp(p.bias ?? 0, -1, 1);
    this.convictionGain = p.convictionGain ?? 0;
  }

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const s = Number(ctx.midMicros);
    const center = Number(ctx.referenceMicros ?? ctx.midMicros); // F1 micro-price compatible
    const sigmaRel = Math.max(ctx.volatility, 0);
    const qLots = clamp(Number(ctx.inventoryUnits) / Number(this.lotUnits), -this.p.maxInventoryLots, this.p.maxInventoryLots);
    const T = this.p.steadyHorizonBars;

    // The bias: a live, per-tick view from the runtime's IBiasSource (ctx.bias —
    // already OOS-gated upstream, so an unvalidated view arrives as 0) overrides the
    // static construction-time default. This is what makes the axe DATA-DRIVEN and
    // re-assessed every tick rather than a frozen number.
    const bias = clamp(ctx.bias ?? this.bias, -1, 1);

    // The axe: skew toward the TARGET inventory q* (= bias·maxLots), not toward 0.
    // effectiveQ = how far we are from where the VIEW wants us; the skew works that
    // off, so the book rests at q* and recycles spread around the held position.
    const targetLots = bias * this.p.maxInventoryLots;
    const effectiveQ = qLots - targetLots;
    let reservation = asReservationMicros(center, effectiveQ, this.p.gamma, sigmaRel, T);
    // Optional conviction drift: nudge the center toward the view (small) so we fill
    // a touch more on the view side even at target — captures momentum while it lasts.
    if (this.convictionGain !== 0 && bias !== 0) {
      reservation += bias * this.convictionGain * sigmaRel * center;
    }

    const halfRaw = asHalfSpreadMicros(s, this.p.gamma, this.p.kappa, sigmaRel, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const railed = railHalfSpread(halfRaw, minMicros, maxMicros);
    const scale = ctx.spreadScale && ctx.spreadScale > 0 ? ctx.spreadScale : 1; // F3
    const halfSpreadMicros = scale === 1 ? railed : bigMax1(BigInt(Math.round(Number(railed) * scale)));

    return buildQuotePair({
      symbol,
      reservationMicros: BigInt(Math.round(reservation)),
      halfSpreadMicros,
      sizeUnits: this.p.quoteSizeUnits,
      ctx,
      strategyId: this.familyId,
      tickSeq: this.tickSeq++,
      clock: this.clock,
    });
  }
}
