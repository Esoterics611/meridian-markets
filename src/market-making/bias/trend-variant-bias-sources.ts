import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// Two live bias sources for the P12 signal expansion, mirroring MomentumBiasSource: both read
// the trailing close-to-close returns the runtime already carries (ctx.recentReturns) and emit a
// validated/honest reading. Same honesty contract as every source: `validated` defaults to FALSE
// so the runtime sizes NO carry until the per-symbol OOS board confirms the signal for that symbol.

/** Sum of the last `lb` returns + their sample stdev (lb≥2). */
function trailingSumAndVol(rets: readonly number[], lookback?: number): { sum: number; vol: number; n: number } {
  const lb = lookback && lookback > 0 ? Math.min(lookback, rets.length) : rets.length;
  if (lb < 1) return { sum: 0, vol: 0, n: 0 };
  const w = rets.slice(rets.length - lb);
  const sum = w.reduce((a, b) => a + b, 0);
  if (w.length < 2) return { sum, vol: 0, n: w.length };
  const mean = sum / w.length;
  let ss = 0;
  for (const r of w) ss += (r - mean) * (r - mean);
  return { sum, vol: Math.sqrt(ss / (w.length - 1)), n: w.length };
}

// ── ReversalBiasSource — "fade the recent pop" ──────────────────────────────────
// The contrarian counterpart to momentum: a positive trailing return ⇒ SHORT bias. Only alpha
// where short-term mean reversion validated OOS for the symbol (regime-board's `reversal` rows).
export interface ReversalBiasParams {
  /** Trailing summed log-return that maps to full bias (|b|=1). e.g. 0.03 (a 3% pop ⇒ full fade). */
  readonly fullBiasReturn: number;
  readonly lookback?: number;
  readonly maxBias?: number;
  readonly validated?: boolean;
}

export class ReversalBiasSource implements IBiasSource {
  constructor(private readonly p: ReversalBiasParams) {}
  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const validated = this.p.validated ?? false;
    const rets = ctx.recentReturns ?? [];
    if (rets.length === 0 || !(this.p.fullBiasReturn > 0)) return { bias: 0, validated, reason: 'reversal flat' };
    const { sum } = trailingSumAndVol(rets, this.p.lookback);
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    const raw = clampBias(-sum / this.p.fullBiasReturn); // FADE: positive trailing return ⇒ short
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);
    return { bias: b, validated, reason: b > 0 ? 'reversal long (fading a dip)' : b < 0 ? 'reversal short (fading a pop)' : 'reversal flat' };
  }
}

// ── VolScaledMomentumBiasSource — risk-adjusted trend ───────────────────────────
// Momentum divided by realised vol: a 2% trend in a calm tape is a stronger view than the same
// trend in a noisy one. Long when the vol-scaled trend (z = Σret/σ) is positive.
export interface VolScaledMomentumBiasParams {
  /** Vol-scaled momentum z (Σret/σ) that maps to full bias (|b|=1). e.g. 1.5. */
  readonly fullBiasZ: number;
  readonly lookback?: number;
  readonly maxBias?: number;
  readonly validated?: boolean;
}

export class VolScaledMomentumBiasSource implements IBiasSource {
  constructor(private readonly p: VolScaledMomentumBiasParams) {}
  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const validated = this.p.validated ?? false;
    const rets = ctx.recentReturns ?? [];
    if (rets.length < 2 || !(this.p.fullBiasZ > 0)) return { bias: 0, validated, reason: 'vol-scaled-momentum flat' };
    const { sum, vol } = trailingSumAndVol(rets, this.p.lookback);
    if (!(vol > 1e-12)) return { bias: 0, validated, reason: 'vol-scaled-momentum flat (no vol)' };
    const z = sum / vol;
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    const raw = clampBias(z / this.p.fullBiasZ);
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);
    return { bias: b, validated, reason: b > 0 ? 'vol-scaled-momentum up' : b < 0 ? 'vol-scaled-momentum down' : 'vol-scaled-momentum flat' };
  }
}
