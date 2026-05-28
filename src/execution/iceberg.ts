import { ChildOrder, IExecAlgo, ParentOrder } from './exec-algo.interface';

// Iceberg — fixed-size visible "tip" children with a hidden residual. Each
// child is tipSizeUnits except possibly the last which carries the leftover.
// Children fire back-to-back at refillIntervalMs spacing so the order book
// only ever sees one tip at a time. This minimises information leakage on
// thin venues at the cost of completion time.
//
// Common use: stat-arb close-outs on illiquid altcoin legs, where signalling
// the full close to the market would invite front-runners.

export interface IcebergConfig {
  /** Visible-tip size per child (USDC units). */
  tipSizeUnits: bigint;
  /** Wall-clock spacing between successive tips (ms). */
  refillIntervalMs: number;
}

export class IcebergAlgo implements IExecAlgo {
  readonly algoId = 'iceberg';

  constructor(private readonly cfg: IcebergConfig) {
    if (cfg.tipSizeUnits <= 0n) throw new Error('IcebergAlgo: tipSizeUnits must be > 0');
    if (cfg.refillIntervalMs <= 0) throw new Error('IcebergAlgo: refillIntervalMs must be > 0');
  }

  sliceOrder(parent: ParentOrder): ChildOrder[] {
    if (parent.maxSlices < 1) throw new Error('IcebergAlgo.sliceOrder: maxSlices must be >= 1');
    if (parent.totalNotionalUnits <= 0n) return [];

    const tip = this.cfg.tipSizeUnits;
    const totalTips = Number(
      parent.totalNotionalUnits / tip + (parent.totalNotionalUnits % tip > 0n ? 1n : 0n),
    );
    const N = Math.min(totalTips, parent.maxSlices);

    let remaining = parent.totalNotionalUnits;
    const out: ChildOrder[] = [];
    for (let i = 0; i < N; i++) {
      if (remaining <= 0n) break;
      const size = remaining < tip ? remaining : tip;
      out.push({
        parentSliceIndex: i,
        symbol: parent.symbol,
        side: parent.side,
        notionalUnits: size,
        scheduleOffsetMs: this.cfg.refillIntervalMs * i,
      });
      remaining -= size;
    }
    return out;
  }
}
