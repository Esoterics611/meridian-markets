import { StatArbBookState } from '../../execution/live-paper-trader';

// IStatArbStateStore — the swap seam for stat-arb live-book persistence
// (CLAUDE.md §7), the exact analogue of IMmStateStore for the MM desk. A
// NullStatArbStateStore (no-op, default) keeps no-DB runs + tests behaving as
// before; a PostgresStatArbStateStore checkpoints each book to stat_arb_book_state
// so realised P&L, the open position, and the drawdown peak survive a restart.
// Selected by config (STAT_ARB_PERSIST). The store never touches the strategy/
// feed/venue — those are rebuilt from the persisted CONFIG on boot; only the
// evolving P&L state is durable.

export const STAT_ARB_STATE_STORE = Symbol('STAT_ARB_STATE_STORE');

/** A book's full durable record: the config needed to rebuild it + its P&L state. */
export interface StatArbBookRecord {
  /** Portfolio map key (= "symbolA/symbolB"); the row PK. */
  bookKey: string;
  symbolA: string;
  symbolB: string;
  /** Data source ('binance'/'alpaca'/'pyth'/…); null ⇒ the default feed source. */
  source: string | null;
  strategyId: string;
  /** Per-pair hedge ratio from discovery; null ⇒ the config default. */
  beta: number | null;
  /** Per-launch strategy param overrides. */
  params: Record<string, number> | null;
  /** Per-leg trade notional (6-dec USDC units). */
  notionalUnits: bigint;
  /** This book's capital anchor (6-dec USDC units). */
  capitalUnits: bigint;
  running: boolean;
  /** The evolving P&L state (LivePaperTrader.serializeState()). */
  state: StatArbBookState;
}

export interface IStatArbStateStore {
  /** True when persistence is active (NullStatArbStateStore ⇒ false). */
  readonly enabled: boolean;
  /** Insert-or-update a book's config + state checkpoint (status ⇒ OPEN). */
  save(record: StatArbBookRecord): Promise<void>;
  /** All OPEN book records, for boot rehydration. */
  loadOpen(): Promise<StatArbBookRecord[]>;
  /** Soft-close a book (status=CLOSED), keeping its row + final P&L. */
  close(bookKey: string): Promise<void>;
}
