import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// FundingBiasSource — the systematic carry view: "be long the side that's PAID"
// (DIRECTIONAL_MM_STRATEGY.md §4, weekly horizon). On a perp, positive funding means
// longs PAY shorts (HL convention), so the paid side is SHORT ⇒ a negative (short)
// bias; negative funding ⇒ a long bias. Magnitude scales with the rate, capped.
//
// CRITICAL HONESTY: using the funding SIGN as a directional (price-predicting) signal
// is a distinct claim from merely harvesting the carry — it must pass an OOS forward-
// return gate before it sizes live carry. So `validated` defaults to FALSE; flip it on
// only after the directional-mm sweep / OOS read confirms it predicts forward return.

export interface FundingBiasParams {
  /** |funding/hr| that maps to full bias (|b|=1), e.g. 0.0000125 (~11%/yr on HL). */
  readonly fullBiasRatePerHour: number;
  /** Cap on |bias| this source emits (≤ 1). Default 1. */
  readonly maxBias?: number;
  /** Has the funding-as-direction signal passed its OOS gate? Default false. */
  readonly validated?: boolean;
}

export class FundingBiasSource implements IBiasSource {
  constructor(private readonly p: FundingBiasParams) {}

  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const validated = this.p.validated ?? false;
    const f = ctx.fundingRatePerHour ?? 0;
    if (f === 0 || this.p.fullBiasRatePerHour <= 0) {
      return { bias: 0, validated, reason: 'funding flat' };
    }
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    // + funding ⇒ longs pay ⇒ be SHORT (negative bias); − funding ⇒ be long.
    const raw = clampBias(-f / this.p.fullBiasRatePerHour);
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);
    return { bias: b, validated, reason: b < 0 ? 'funding-paid short' : 'funding-paid long' };
  }
}
