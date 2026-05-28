import { Side } from '../stat-arb/trading-venue.interface';

// IExecAlgo — slices a parent order into child orders. Each algo has its own
// scheduling policy (TWAP = evenly across time; VWAP = volume-weighted; POV =
// fraction of running volume; iceberg = small visible slices with hidden
// reserve). Session 13 lite ships TWAP only.

export interface ParentOrder {
  symbol: string;
  side: Side;
  totalNotionalUnits: bigint;
  /** Maximum number of child slices to emit. */
  maxSlices: number;
}

export interface ChildOrder {
  parentSliceIndex: number;
  symbol: string;
  side: Side;
  notionalUnits: bigint;
  /** Offset from the start of the schedule, ms. */
  scheduleOffsetMs: number;
}

export interface IExecAlgo {
  readonly algoId: string;
  sliceOrder(parent: ParentOrder): ChildOrder[];
}
