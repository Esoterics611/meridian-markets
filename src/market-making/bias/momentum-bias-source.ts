import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// MomentumBiasSource — the systematic trend view: "be long the side that's MOVING"
// (the momentum signal validated in the directional OOS sweep, forward-return-ic.ts).
// It reads the trailing close-to-close returns the runtime already carries on the
// BiasContext (recentReturns) and leans the book the way they sum: a positive trailing
// return ⇒ long bias, negative ⇒ short. This is the second constituent (beside
// FundingBiasSource) of the standalone book's ConsensusBiasSource.
//
// CRITICAL HONESTY (same as FundingBiasSource): a trend signal is alpha only if it
// predicts FORWARD return out-of-sample, so `validated` defaults to FALSE — the runtime
// sizes NO position from it until the per-symbol OOS board (regime-board.ts) confirms
// momentum validated for that symbol. effectiveBias() then zeroes it everywhere it isn't.

export interface MomentumBiasParams {
  /** Trailing summed log-return that maps to full bias (|b|=1), e.g. 0.05 (a 5% trend). */
  readonly fullBiasReturn: number;
  /** Sum only the most-recent N returns (default: all the context provides). */
  readonly lookback?: number;
  /** Cap on |bias| this source emits (≤ 1). Default 1. */
  readonly maxBias?: number;
  /** Has the momentum-as-direction signal passed its OOS gate for this symbol? Default false. */
  readonly validated?: boolean;
}

export class MomentumBiasSource implements IBiasSource {
  constructor(private readonly p: MomentumBiasParams) {}

  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const validated = this.p.validated ?? false;
    const rets = ctx.recentReturns ?? [];
    if (rets.length === 0 || !(this.p.fullBiasReturn > 0)) {
      return { bias: 0, validated, reason: 'momentum flat' };
    }
    const lb = this.p.lookback && this.p.lookback > 0 ? Math.min(this.p.lookback, rets.length) : rets.length;
    let sum = 0;
    for (let i = rets.length - lb; i < rets.length; i++) sum += rets[i];
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    // Long the trend: positive trailing return ⇒ positive (long) bias.
    const raw = clampBias(sum / this.p.fullBiasReturn);
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);
    return { bias: b, validated, reason: b > 0 ? 'momentum up' : b < 0 ? 'momentum down' : 'momentum flat' };
  }
}
