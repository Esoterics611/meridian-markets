import { L2Snapshot } from '../../market-data/reference/reference-source.interface';
import { IntervalFlowLike } from '../backtest/l2-tape';

// Shared live-engine types — the one input shape the fast L2 path passes around, so
// the poll driver (l2-poll-driver.ts) and the fill engine (l2-live-fill-engine.ts)
// agree on it without either importing the other. A LiveTick is one live depth
// snapshot plus the aggressor flow that arrived over the interval ending at it
// (undefined ⇒ a depth-only tick: re-quote + decay the queue, book no fills).

export interface LiveTick {
  /** The live L2 depth snapshot. */
  snapshot: L2Snapshot;
  /** Aggressor flow + traded extremes over the interval ending at this snapshot. */
  flow?: IntervalFlowLike;
}
