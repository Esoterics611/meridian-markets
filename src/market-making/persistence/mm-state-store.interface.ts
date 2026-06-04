import { MmBookState } from '../live/mm-book';

// IMmStateStore — the swap seam for MM book persistence (CLAUDE.md §7). A
// NullMmStateStore (no-op, default) keeps no-DB runs + tests behaving exactly as
// before; a PostgresMmStateStore checkpoints each book to mm_book_state so P&L,
// positions, and NAV survive a restart (restart-safe books). Selected by config
// (MM_PERSIST). The store never touches the quoter/feed/risk gate — those are
// rebuilt from the persisted CONFIG on boot; only the evolving P&L state is durable.

export const MM_STATE_STORE = Symbol('MM_STATE_STORE');

/** A book's full durable record: the config needed to rebuild it + its P&L state. */
export interface MmBookRecord {
  /** Portfolio map key (= symbol); the row PK. */
  bookKey: string;
  symbol: string;
  /** Venue source ('hyperliquid'/'binance'/…); null ⇒ the default feed. */
  source: string | null;
  strategyId: string;
  params: Record<string, number> | null;
  gamma: number;
  kappa: number;
  horizonBars: number;
  volWindowBars: number;
  volFloor: number;
  makerFeeBps: number;
  fundingRatePerHour: number;
  quoteSizeUnits: bigint;
  capitalUnits: bigint;
  running: boolean;
  /** The evolving ledger + accumulators (MmBook.serializeState()). */
  state: MmBookState;
}

export interface IMmStateStore {
  /** True when persistence is active (NullMmStateStore ⇒ false). */
  readonly enabled: boolean;
  /** Insert-or-update a book's config + state checkpoint (status ⇒ OPEN). */
  save(record: MmBookRecord): Promise<void>;
  /** All OPEN book records, for boot rehydration. */
  loadOpen(): Promise<MmBookRecord[]>;
  /** Soft-close a book (status=CLOSED), keeping its row + final P&L. */
  close(bookKey: string): Promise<void>;
}
