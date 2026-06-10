// MarkoutTracker — the canonical market-maker adverse-selection diagnostic.
//
// For each fill we record the fair mid at fill time, then re-mark it against the
// mid at several forward HORIZONS (1s / 5s / 30s …). The signed markout, in bps
// from the fill's own perspective, is:
//
//   markout = side · (mid_{t+h} − fairMid_t) / fairMid_t · 1e4   (BUY: +1, SELL: −1)
//
// so POSITIVE = the move went our way (we were on the right side), NEGATIVE =
// adverse (the mid ran away from us after we traded — getting picked off). A
// curve that sinks further negative as the horizon grows is the signature of
// toxic/informed flow. This is the per-fill *average* markout, complementary to
// the cumulative adverse-selection $ column (which is the same effect summed).
//
// Pure + deterministic; an observer only (never touches cash/fills), fed from
// both the bar path (bar timestamps) and the fast L2 path (real ms prints). The
// horizon is resolved at the first mid AT OR AFTER it — standard practice when
// you only have discrete prints.

export interface MarkoutPoint {
  /** Forward horizon in ms. */
  readonly ms: number;
  /** Average per-fill markout in bps at this horizon; null until a fill resolves it. */
  readonly bps: number | null;
  /** Fills resolved at this horizon so far. */
  readonly count: number;
}

interface PendingFill {
  tFillMs: number;
  fairMid: bigint;
  sign: number; // +1 BUY, −1 SELL
  resolved: number; // count of horizons already marked
}

/** The buy/sell-split curves (WP2: per-side markout — asymmetry between the sides is the
 *  signature of one-sided informed flow that a symmetric widen cannot price). */
export interface MarkoutSideCurves {
  buy: MarkoutPoint[];
  sell: MarkoutPoint[];
}

export class MarkoutTracker {
  private readonly horizonsMs: number[];
  private readonly sumBps: number[];
  private readonly counts: number[];
  // Per-side accumulators (index 0 = BUY fills, 1 = SELL fills).
  private readonly sideSumBps: [number[], number[]];
  private readonly sideCounts: [number[], number[]];
  private pending: PendingFill[] = [];

  constructor(horizonsMs: number[]) {
    // Sort ascending + dedupe so the resolve loop can walk horizons in order.
    this.horizonsMs = [...new Set(horizonsMs.filter((h) => h > 0))].sort((a, b) => a - b);
    this.sumBps = this.horizonsMs.map(() => 0);
    this.counts = this.horizonsMs.map(() => 0);
    this.sideSumBps = [this.horizonsMs.map(() => 0), this.horizonsMs.map(() => 0)];
    this.sideCounts = [this.horizonsMs.map(() => 0), this.horizonsMs.map(() => 0)];
  }

  /** Record a fill to be marked out at each forward horizon. */
  onFill(side: 'BUY' | 'SELL', fairMidMicros: bigint, tFillMs: number): void {
    if (fairMidMicros <= 0n || this.horizonsMs.length === 0) return;
    this.pending.push({ tFillMs, fairMid: fairMidMicros, sign: side === 'BUY' ? 1 : -1, resolved: 0 });
  }

  /** Advance the clock: mark every pending fill whose age has reached a new horizon. */
  onMid(nowMs: number, midMicros: bigint): void {
    if (midMicros <= 0n || this.pending.length === 0) return;
    const n = this.horizonsMs.length;
    for (const p of this.pending) {
      const age = nowMs - p.tFillMs;
      while (p.resolved < n && age >= this.horizonsMs[p.resolved]) {
        const i = p.resolved;
        const bps = (p.sign * Number(midMicros - p.fairMid) * 10000) / Number(p.fairMid);
        this.sumBps[i] += bps;
        this.counts[i] += 1;
        const s = p.sign > 0 ? 0 : 1; // 0 = BUY, 1 = SELL
        this.sideSumBps[s][i] += bps;
        this.sideCounts[s][i] += 1;
        p.resolved += 1;
      }
    }
    // Drop fills that have resolved every horizon.
    if (this.pending.some((p) => p.resolved >= n)) {
      this.pending = this.pending.filter((p) => p.resolved < n);
    }
  }

  /** The markout curve: average bps per fill at each horizon (null until resolved). */
  curve(): MarkoutPoint[] {
    return this.horizonsMs.map((ms, i) => ({
      ms,
      bps: this.counts[i] > 0 ? this.sumBps[i] / this.counts[i] : null,
      count: this.counts[i],
    }));
  }

  /** The same curve split by fill side (WP2). Both curves use the fill's own sign convention,
   *  so negative = adverse for that side; a side sinking while the other holds = one-sided flow. */
  sideCurves(): MarkoutSideCurves {
    const sideOf = (s: 0 | 1): MarkoutPoint[] =>
      this.horizonsMs.map((ms, i) => ({
        ms,
        bps: this.sideCounts[s][i] > 0 ? this.sideSumBps[s][i] / this.sideCounts[s][i] : null,
        count: this.sideCounts[s][i],
      }));
    return { buy: sideOf(0), sell: sideOf(1) };
  }
}
