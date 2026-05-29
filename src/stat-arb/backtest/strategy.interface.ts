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

// The spread-position regime, shared by every 2-leg strategy.
export type Regime = 'LONG' | 'SHORT' | 'FLAT';

// ManagedStrategy is the contract the desk's registry, the backtest runner, and
// the live paper loop all agree on. It is IStrategy plus the small read/reset
// surface those drivers need (last z for the dashboard, current β/regime, a
// rollback when a risk gate rejects an OPEN, and a reset for pair switching).
// PairsStrategy, BollingerPairsStrategy and OuSpreadStrategy all satisfy it; it
// is structurally assignable to the looser LiveStrategy the live loop declares.
export interface ManagedStrategy extends IStrategy {
  /** Last computed z-score / standardised deviation (NaN until warm). */
  lastZ: number;
  /** β actually in use right now (constructor value or latest refit). */
  currentBeta(): number;
  /** Current spread-position regime. */
  currentRegime(): Regime;
  /** Restore to FLAT after the runner/loop rejects an OPEN. */
  rollbackEntry(): void;
  /** Wipe per-pair state so the instance can be reused on a different pair. */
  reset(): void;
}
