import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';

// POV — percent-of-volume. Each child is sized at most `participationPct%` of
// the market's expected per-interval volume. This is a participation-limited
// algo: the parent will under-fill if the market is too thin to support its
// size at the given participation rate within the horizon.
//
// `intervalVolumeUnits` is the expected USDC volume per `intervalMs` window
// (e.g., per-minute volume). The algo schedules children at intervalMs spacing
// until the parent fills or the horizon is consumed.

export interface PovConfig {
  /** Participation rate as percentage of market volume per interval. 1..100. */
  participationPct: number;
  /** Expected market volume per scheduling interval, in USDC units. */
  intervalVolumeUnits: bigint;
  /** Spacing between child slices, ms. */
  intervalMs: number;
  /** Cap on total horizon ms. Children past this point are dropped (parent under-fills). */
  horizonMs: number;
}

export class PovAlgo implements IExecAlgo {
  readonly algoId = 'pov';

  constructor(private readonly cfg: PovConfig) {
    if (cfg.participationPct <= 0 || cfg.participationPct > 100) {
      throw new Error('PovAlgo: participationPct must be in (0, 100]');
    }
    if (cfg.intervalVolumeUnits <= 0n) throw new Error('PovAlgo: intervalVolumeUnits must be > 0');
    if (cfg.intervalMs <= 0) throw new Error('PovAlgo: intervalMs must be > 0');
    if (cfg.horizonMs <= 0) throw new Error('PovAlgo: horizonMs must be > 0');
  }

  sliceOrder(parent: ParentOrder): ChildOrder[] {
    if (parent.maxSlices < 1) throw new Error('PovAlgo.sliceOrder: maxSlices must be >= 1');
    if (parent.totalNotionalUnits <= 0n) return [];

    // Per-slice cap: pct * intervalVolume / 100, with bigint floor.
    const perSlice = (this.cfg.intervalVolumeUnits * BigInt(Math.floor(this.cfg.participationPct))) / 100n;
    if (perSlice <= 0n) return [];

    const maxByHorizon = Math.floor(this.cfg.horizonMs / this.cfg.intervalMs) + 1; // inclusive of t=0
    const N = Math.min(parent.maxSlices, maxByHorizon);

    let remaining = parent.totalNotionalUnits;
    const out: ChildOrder[] = [];
    for (let i = 0; i < N; i++) {
      if (remaining <= 0n) break;
      const size = remaining < perSlice ? remaining : perSlice;
      out.push({
        parentSliceIndex: i,
        symbol: parent.symbol,
        side: parent.side,
        notionalUnits: size,
        scheduleOffsetMs: this.cfg.intervalMs * i,
      });
      remaining -= size;
    }
    return out;
  }
}
