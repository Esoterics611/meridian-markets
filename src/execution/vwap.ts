import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';

// VWAP — volume-weighted slicing. Children sized in proportion to a passed-in
// historical-volume curve so the parent participates with the market rather
// than against it. The volume curve is an arbitrary-length non-negative
// number array; each slice consumes one bucket. If buckets > maxSlices we
// aggregate consecutive buckets evenly; if buckets < maxSlices we throw.
//
// VWAP is the right algo when the parent is "fair-execution" sensitive — the
// goal is to match the realised VWAP price, not to be cheap-impact.

export interface VwapConfig {
  /** Per-bucket relative volume weights. At least one positive entry. */
  volumeCurve: number[];
  /** Total horizon ms over which to spread the slices. */
  horizonMs: number;
}

export class VwapAlgo implements IExecAlgo {
  readonly algoId = 'vwap';

  constructor(private readonly cfg: VwapConfig) {
    if (cfg.horizonMs <= 0) throw new Error('VwapAlgo: horizonMs must be > 0');
    if (cfg.volumeCurve.length === 0) throw new Error('VwapAlgo: volumeCurve cannot be empty');
    if (cfg.volumeCurve.some((v) => v < 0)) throw new Error('VwapAlgo: volumeCurve entries must be >= 0');
    if (cfg.volumeCurve.every((v) => v === 0)) throw new Error('VwapAlgo: volumeCurve must contain at least one positive value');
  }

  sliceOrder(parent: ParentOrder): ChildOrder[] {
    if (parent.maxSlices < 1) throw new Error('VwapAlgo.sliceOrder: maxSlices must be >= 1');
    if (parent.totalNotionalUnits <= 0n) return [];
    const curve = this.cfg.volumeCurve;
    const N = Math.min(curve.length, parent.maxSlices);

    // Aggregate the curve down to N buckets if needed. Each output bucket sums
    // the consecutive input weights that fall into it.
    const buckets: number[] = new Array(N).fill(0);
    for (let i = 0; i < curve.length; i++) {
      const targetBucket = Math.min(N - 1, Math.floor((i * N) / curve.length));
      buckets[targetBucket] += curve[i];
    }
    const total = buckets.reduce((s, v) => s + v, 0);
    if (total <= 0) return [];

    // Compute integer notional per slice, then dump the rounding remainder onto the largest slice.
    const sliceSizes: bigint[] = buckets.map((w) => {
      const frac = w / total;
      return BigInt(Math.floor(Number(parent.totalNotionalUnits) * frac));
    });
    const allocated = sliceSizes.reduce((s, v) => s + v, 0n);
    const remainder = parent.totalNotionalUnits - allocated;
    if (remainder > 0n) {
      // Largest weight gets the rounding crumbs.
      let biggest = 0;
      for (let i = 1; i < buckets.length; i++) if (buckets[i] > buckets[biggest]) biggest = i;
      sliceSizes[biggest] = sliceSizes[biggest] + remainder;
    }

    const stepMs = this.cfg.horizonMs / N;
    const out: ChildOrder[] = [];
    for (let i = 0; i < N; i++) {
      if (sliceSizes[i] <= 0n) continue;
      out.push({
        parentSliceIndex: i,
        symbol: parent.symbol,
        side: parent.side,
        notionalUnits: sliceSizes[i],
        scheduleOffsetMs: Math.round(stepMs * i),
      });
    }
    return out;
  }
}
