import { BiasContext, BiasReading, IBiasSource, clampBias, effectiveBias } from './bias-source.interface';

// CompositeBiasSource — the chosen blend (the "systematic + house-view override"
// decision): a SYSTEMATIC source (e.g. FundingBiasSource) provides the default view,
// and a MANUAL house-view source can OVERRIDE it — but the override is "capped by the
// data": it may not point OPPOSITE a non-neutral systematic signal. The rule:
//
//   • no (validated, non-zero) manual view ⇒ the systematic default drives;
//   • manual view present and AGREES in sign with the systematic (or systematic is
//     neutral) ⇒ the manual conviction is used (it's the stronger, longer-horizon call);
//   • manual view CONFLICTS with a non-neutral systematic signal ⇒ stand aside (b=0).
//     The data wins ties against a view it contradicts — you don't ride a directional
//     bet the carry/flow is fighting.
//
// Only validated readings carry weight (effectiveBias enforces the OOS gate), so an
// unvalidated manual view falls back to the systematic, and an unvalidated systematic
// contributes nothing to the conflict check. Pure + composable.

export class CompositeBiasSource implements IBiasSource {
  constructor(
    private readonly systematic: IBiasSource,
    private readonly manual: IBiasSource,
  ) {}

  bias(symbol: string, ctx: BiasContext): BiasReading {
    const s = this.systematic.bias(symbol, ctx);
    const m = this.manual.bias(symbol, ctx);
    const mEff = effectiveBias(m); // 0 unless validated
    if (mEff === 0) return s; // no override ⇒ the systematic default

    const sEff = effectiveBias(s);
    if (sEff !== 0 && Math.sign(mEff) !== Math.sign(sEff)) {
      // The house view contradicts a live, validated data signal ⇒ data wins, stand aside.
      return { bias: 0, validated: true, reason: `view ${m.reason} vs data ${s.reason} ⇒ neutral` };
    }
    // Agree (or systematic neutral): take the house-view conviction.
    return { bias: clampBias(mEff), validated: true, reason: `house view: ${m.reason}` };
  }
}
