import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// FlowImbalanceBiasSource — the FAST directional view: lean toward the side the book is
// pressing (DIRECTIONAL_MM_STRATEGY.md / FAIR_VALUE_AND_THESIS_DESIGN.md §Layer C). A
// bid-heavy book (imbalance > 0) tends to tick UP ⇒ a LONG (positive) bias; ask-heavy ⇒
// short. Magnitude scales with the imbalance, capped. Unlike the weekly funding axe this
// re-evaluates every snapshot (the genuinely "fresh every 100ms" directional input).
//
// CRITICAL HONESTY: book imbalance is a well-known *microstructure* predictor, but
// whether it predicts forward return NET on this venue/cadence is an empirical claim —
// so `validated` defaults to FALSE (shadow). Until it clears the markout / forward-return
// gate (scripts/flow-bias-markout.ts), effectiveBias() zeroes it and it sizes NO carry.
// Same lesson as #33: an unvalidated bias is leverage on noise.

export interface FlowBiasParams {
  /** Book imbalance that maps to full pre-cap bias (|raw|=1). e.g. 0.6 ⇒ imbalance 0.6 → full lean. */
  readonly fullBiasImbalance: number;
  /** Cap on |bias| this source emits (≤ 1). Default 1. */
  readonly maxBias?: number;
  /** Has flow-imbalance-as-direction passed its forward-return gate? Default false (shadow). */
  readonly validated?: boolean;
}

export class FlowImbalanceBiasSource implements IBiasSource {
  constructor(private readonly p: FlowBiasParams) {}

  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const validated = this.p.validated ?? false;
    const imb = ctx.bookImbalance ?? 0;
    if (imb === 0 || this.p.fullBiasImbalance <= 0) {
      return { bias: 0, validated, reason: 'flow flat' };
    }
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    // + imbalance (bid-heavy ⇒ price ticks up) ⇒ be LONG (positive bias).
    const raw = clampBias(imb / this.p.fullBiasImbalance);
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);
    return { bias: b, validated, reason: b > 0 ? 'flow-imbalance long' : 'flow-imbalance short' };
  }
}
