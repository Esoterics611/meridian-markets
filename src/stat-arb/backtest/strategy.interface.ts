import { Bar } from './bar';
import { Side } from '../trading-venue.interface';

// IStrategy is the seam between the backtest's event loop and the trading
// logic. The runner calls onBar() in chronological order with no lookahead;
// the strategy may inspect history (bars it has already seen) but never
// future bars. Two strategies on the same feed must produce the same orders
// — that property is asserted in backtest.spec.ts.

export interface BarContext {
  a: Bar;
  b: Bar;
  index: number;
  /** Bars seen so far, INCLUSIVE of the current one. The strategy never sees later bars. */
  historyA: Bar[];
  historyB: Bar[];
}

export interface DesiredOrder {
  symbol: string;
  side: Side;
  notionalUnits: bigint;
  reason: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE';
}

export interface IStrategy {
  onBar(ctx: BarContext): DesiredOrder[];
}
