import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';

// TWAP — slice the parent into N equally-sized child orders spaced evenly
// across the schedule horizon. Last slice gets any rounding remainder so
// sum(child notionals) === parent notional exactly.

export interface TwapConfig {
  /** Total horizon ms over which to spread the slices. */
  horizonMs: number;
}

export class TwapAlgo implements IExecAlgo {
  readonly algoId = 'twap';

  constructor(private readonly cfg: TwapConfig) {
    if (cfg.horizonMs <= 0) throw new Error('TwapAlgo: horizonMs must be > 0');
  }

  sliceOrder(parent: ParentOrder): ChildOrder[] {
    if (parent.maxSlices < 1) throw new Error('TwapAlgo.sliceOrder: maxSlices must be >= 1');
    if (parent.totalNotionalUnits <= 0n) return [];
    const N = parent.maxSlices;
    const per = parent.totalNotionalUnits / BigInt(N);
    const remainder = parent.totalNotionalUnits - per * BigInt(N);
    const stepMs = this.cfg.horizonMs / N;
    const out: ChildOrder[] = [];
    for (let i = 0; i < N; i++) {
      const size = i === N - 1 ? per + remainder : per;
      if (size <= 0n) continue;
      out.push({
        parentSliceIndex: i,
        symbol: parent.symbol,
        side: parent.side,
        notionalUnits: size,
        scheduleOffsetMs: Math.round(stepMs * i),
      });
    }
    return out;
  }
}
