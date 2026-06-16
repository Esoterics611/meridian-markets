import { BiasContext, BiasReading, IBiasSource, NEUTRAL_BIAS, clampBias, effectiveBias } from '../bias/bias-source.interface';

// ConsensusBiasSource — the "statistically obvious chance" gate for the standalone
// regime directional book (REGIME_DIRECTIONAL_BOOK.md). It wraps N independent,
// individually-OOS-gated IBiasSources (funding / flow / momentum / house view) and
// expresses a view ONLY when several of them AGREE — the conservative, risk-averse
// rule the desk's directional book trades on: "take sides only when funding + trend
// align."
//
// The honesty gate is inherited, not re-implemented: effectiveBias() already zeroes
// any unvalidated reading, so an un-gated source contributes NOTHING to the vote. On
// top of that:
//   • fewer than `minAgree` validated same-sign votes ⇒ NEUTRAL (no view);
//   • any opposing validated vote (with vetoOnConflict) ⇒ NEUTRAL (stand aside on
//     internal disagreement — you do not lean the book when your own signals fight);
//   • otherwise ⇒ the mean of the agreeing (validated) biases, clamped to [−1,+1].
//
// Pure + composable, same swap-seam discipline as every bias source (CLAUDE.md §7).

export interface ConsensusConfig {
  /** Minimum validated, same-sign constituent votes required to express a view. Default 2. */
  readonly minAgree?: number;
  /**
   * If true, ANY opposing validated vote forces NEUTRAL — the conservative
   * "stand aside on disagreement" rule. Default true.
   */
  readonly vetoOnConflict?: boolean;
}

export class ConsensusBiasSource implements IBiasSource {
  private readonly minAgree: number;
  private readonly vetoOnConflict: boolean;

  constructor(
    private readonly sources: readonly IBiasSource[],
    cfg: ConsensusConfig = {},
  ) {
    this.minAgree = Math.max(1, Math.floor(cfg.minAgree ?? 2));
    this.vetoOnConflict = cfg.vetoOnConflict ?? true;
  }

  bias(symbol: string, ctx: BiasContext): BiasReading {
    // effectiveBias = 0 unless the source's own reading is validated — the OOS gate
    // is enforced here, once, for every constituent.
    const effs = this.sources.map((s) => effectiveBias(s.bias(symbol, ctx)));
    const longs = effs.filter((e) => e > 0);
    const shorts = effs.filter((e) => e < 0);

    if (longs.length === 0 && shorts.length === 0) {
      return { bias: 0, validated: true, reason: 'consensus: no validated view' };
    }
    if (this.vetoOnConflict && longs.length > 0 && shorts.length > 0) {
      return { bias: 0, validated: true, reason: `consensus: conflict ${longs.length}↑/${shorts.length}↓ ⇒ neutral` };
    }

    const longWins = longs.length >= shorts.length;
    const winners = longWins ? longs : shorts;
    if (winners.length < this.minAgree) {
      return { bias: 0, validated: true, reason: `consensus: only ${winners.length}/${this.minAgree} agree ⇒ neutral` };
    }

    const mean = winners.reduce((a, b) => a + b, 0) / winners.length;
    return {
      bias: clampBias(mean),
      validated: true,
      reason: `consensus: ${winners.length} agree ${longWins ? 'long' : 'short'}`,
    };
  }
}

/** Re-export the neutral reading for callers that branch on "no consensus". */
export { NEUTRAL_BIAS };
