import { ALLOW, deny, GateDecision } from './gate';

// CorrelationCapGate — blocks new pair entries when their proposed leg
// is highly correlated with the existing book. Lightweight proxy: caller
// supplies the candidate's return series and the open positions' return
// series; we compute the maximum |Pearson r| against any open leg.

export interface CorrelationCapConfig {
  /** Block entries whose maximum |corr| with any open leg exceeds this. */
  maxAbsCorrelation: number;
  /** Minimum overlap (bars) required to compute correlation. Below it: allow. */
  minOverlapBars: number;
}

export interface CorrelationState {
  candidate: number[];
  openLegs: { id: string; returns: number[] }[];
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

export class CorrelationCapGate {
  constructor(private readonly cfg: CorrelationCapConfig) {}

  check(s: CorrelationState): GateDecision {
    let worst = { id: '', corr: 0 };
    for (const leg of s.openLegs) {
      const overlap = Math.min(s.candidate.length, leg.returns.length);
      if (overlap < this.cfg.minOverlapBars) continue;
      const slice = s.candidate.slice(-overlap);
      const ref = leg.returns.slice(-overlap);
      const c = pearson(slice, ref);
      if (Math.abs(c) > Math.abs(worst.corr)) worst = { id: leg.id, corr: c };
    }
    if (Math.abs(worst.corr) > this.cfg.maxAbsCorrelation) {
      return deny(
        `corr ${worst.corr.toFixed(3)} with leg ${worst.id} > cap ${this.cfg.maxAbsCorrelation}`,
        { legId: worst.id, corr: worst.corr, cap: this.cfg.maxAbsCorrelation },
      );
    }
    return ALLOW;
  }
}
