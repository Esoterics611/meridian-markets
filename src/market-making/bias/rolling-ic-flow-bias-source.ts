import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// RollingIcFlowBiasSource — the LIVE, self-validating fast directional view (what a real
// systematic desk runs): the bias VALUE updates every tick off the book imbalance, AND
// the bias VALIDITY is re-checked every `evalEveryMs` against its own trailing forward-
// return IC. It sizes carry ONLY while it stays predictive, per coin — so a signal that
// works on BTC but reverses on DOGE turns itself ON for BTC and OFF for DOGE with no
// hand-tuning. This is the honest "reevaluate the bias dynamically" loop: the OOS gate
// becomes continuous and live, not a one-shot config flag.
//
// Reversal guard: a NEGATIVE trailing IC means the microsignal is anti-predictive right
// now — we do NOT flip the sign and chase it (that's how you get run over); we stand
// aside (validated=false ⇒ effectiveBias 0 ⇒ the directional quoter mean-reverts to q*=0).

interface Pt {
  ts: number;
  sig: number;
  mid: number;
}

export interface RollingFlowBiasParams {
  /** Book imbalance that maps to full pre-cap bias (|raw|=1). */
  readonly fullBiasImbalance: number;
  /** Cap on |bias| emitted (≤ 1). Default 1. */
  readonly maxBias?: number;
  /** Forward-return horizon (ms) the rolling IC is scored over. Default 60000. */
  readonly horizonMs?: number;
  /** How often (ms) to recompute the trailing IC and flip validity. Default 60000. */
  readonly evalEveryMs?: number;
  /** Trailing window (ms) of observations kept for the IC. Default 1_200_000 (20m). */
  readonly windowMs?: number;
  /** Min scored (signal, forward-return) pairs before any verdict. Default 100. */
  readonly minPairs?: number;
  /** Min trailing Spearman IC to validate (size carry). Default 0.05. */
  readonly icThreshold?: number;
}

export class RollingIcFlowBiasSource implements IBiasSource {
  private readonly buf: Pt[] = [];
  private validatedFlag = false;
  private lastIcValue = NaN;
  private lastEvalMs = Number.NEGATIVE_INFINITY;
  private reasonStr = 'flow warming';

  constructor(private readonly p: RollingFlowBiasParams) {}

  bias(_symbol: string, ctx: BiasContext): BiasReading {
    const imb = ctx.bookImbalance ?? 0;
    const maxB = Math.min(this.p.maxBias ?? 1, 1);
    const raw = this.p.fullBiasImbalance > 0 ? clampBias(imb / this.p.fullBiasImbalance) : 0;
    const b = Math.sign(raw) * Math.min(Math.abs(raw), maxB);

    // Record (ts, signal, mid) so the gate can score the signal's realized forward return.
    const mid = ctx.midMicros !== undefined ? Number(ctx.midMicros) : NaN;
    if (Number.isFinite(mid) && mid > 0) {
      this.buf.push({ ts: ctx.nowMs, sig: b, mid });
      const cutoff = ctx.nowMs - (this.p.windowMs ?? 1_200_000);
      while (this.buf.length && this.buf[0].ts < cutoff) this.buf.shift();
      if (ctx.nowMs - this.lastEvalMs >= (this.p.evalEveryMs ?? 60_000)) {
        this.reevaluate();
        this.lastEvalMs = ctx.nowMs;
      }
    }
    return { bias: b, validated: this.validatedFlag, reason: this.reasonStr };
  }

  /** Recompute the trailing forward-return IC and flip validity (the dynamic gate). */
  private reevaluate(): void {
    const horizon = this.p.horizonMs ?? 60_000;
    const sig: number[] = [];
    const fwd: number[] = [];
    let j = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const target = this.buf[i].ts + horizon;
      if (j < i + 1) j = i + 1;
      while (j < this.buf.length && this.buf[j].ts < target) j++;
      if (j >= this.buf.length) break;
      const p0 = this.buf[i].mid;
      if (p0 > 0 && this.buf[i].sig !== 0) {
        sig.push(this.buf[i].sig);
        fwd.push(this.buf[j].mid / p0 - 1);
      }
    }
    if (sig.length < (this.p.minPairs ?? 100)) {
      this.validatedFlag = false;
      this.lastIcValue = NaN;
      this.reasonStr = `flow warming (${sig.length} pairs)`;
      return;
    }
    const ic = spearman(sig, fwd);
    this.lastIcValue = ic;
    const thr = this.p.icThreshold ?? 0.05;
    // Validate ONLY on a positive, material IC. Negative IC = reversal ⇒ stand aside.
    this.validatedFlag = Number.isFinite(ic) && ic >= thr;
    this.reasonStr = this.validatedFlag
      ? `flow validated (IC ${ic.toFixed(3)}, n=${sig.length})`
      : `flow not predictive (IC ${Number.isFinite(ic) ? ic.toFixed(3) : 'n/a'}, n=${sig.length})`;
  }

  /** Last computed trailing IC (NaN until the first eval with enough pairs). */
  get ic(): number {
    return this.lastIcValue;
  }

  /** Whether the live signal currently sizes carry. */
  get isValidated(): boolean {
    return this.validatedFlag;
  }
}

/** Spearman rank correlation (ties → average rank). NaN for n<3 or zero variance. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = (a: number[]): number[] => {
    const idx = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n).fill(0);
    for (let i = 0; i < n; ) {
      let k = i;
      while (k + 1 < n && idx[k + 1][0] === idx[i][0]) k++;
      const avg = (i + k) / 2 + 1;
      for (let t = i; t <= k; t++) r[idx[t][1]] = avg;
      i = k + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = rx[i] - mx;
    const ay = ry[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}
