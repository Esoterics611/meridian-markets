import { FundingCarryBookState } from './funding-carry-book';
import { CarryDirection } from '../../market-data/funding/funding-carry-discovery';

// ICarryStateStore — the persistence seam for the carry desk (PROFIT_PIVOT_II P0),
// the exact P6 pattern: a NullCarryStateStore (no-op default) keeps DB-free runs and
// tests unchanged; a PostgresCarryStateStore checkpoints each book to carry_book_state
// and the equity curve to mm_nav (desk='carry', '@carry' book_key namespace).
//
// ONE deliberate difference from the regime desk: on shutdown the carry desk does NOT
// flatten when persistence is on — carry is a hold-past-breakeven trade, and paying the
// round-trip fee on every restart would destroy exactly the economics the book exists
// to measure. The position is checkpointed OPEN and RESUMED on the next boot. (With
// persistence OFF the runner flattens at exit — no dangling paper position, ever.)

/** A carry book's full durable record: enough to resume the held pair on boot. */
export interface CarryBookRecord {
  /** Symbol = the row PK (one carry book per symbol). */
  readonly symbol: string;
  readonly direction: CarryDirection;
  /** The gate's full-window gross carry at entry (for the resume log / review). */
  readonly gateAnnualizedPct: number;
  /** Entry epoch ms — null when flat. */
  readonly entryMs: number | null;
  /** The evolving two-leg ledger (FundingCarryBook.serializeState()). */
  readonly state: FundingCarryBookState;
}

/** One desk/per-book equity-curve row for mm_nav (desk='carry'). */
export interface CarryNavInsert {
  readonly asOf: Date;
  /** '' = the carry desk aggregate; else a symbol. Namespaced under '@carry'. */
  readonly bookKey: string;
  readonly equityUnits: bigint;
  readonly realisedPnlUnits: bigint;
  readonly unrealisedPnlUnits: bigint;
  readonly feesUnits: bigint;
  readonly fundingUnits: bigint;
  readonly inventoryUnits: bigint;
  readonly maxDrawdownPct: number;
}

export interface ICarryStateStore {
  /** True when persistence is active (NullCarryStateStore ⇒ false). */
  readonly enabled: boolean;
  /** Insert-or-update a book's state checkpoint (status ⇒ OPEN). */
  saveBook(record: CarryBookRecord): Promise<void>;
  /** All OPEN book records, for boot rehydration. */
  loadOpen(): Promise<CarryBookRecord[]>;
  /** Soft-close a book (status=CLOSED), keeping its row + final P&L. */
  closeBook(symbol: string): Promise<void>;
  /** Append a batch of equity-curve rows (desk row + per-book rows) — append-only. */
  appendNav(rows: CarryNavInsert[]): Promise<void>;
}

/** The safe default: persistence off, every call a no-op. DB-free runs are unchanged. */
export class NullCarryStateStore implements ICarryStateStore {
  readonly enabled = false;
  async saveBook(_record: CarryBookRecord): Promise<void> {
    /* no-op */
  }
  async loadOpen(): Promise<CarryBookRecord[]> {
    return [];
  }
  async closeBook(_symbol: string): Promise<void> {
    /* no-op */
  }
  async appendNav(_rows: CarryNavInsert[]): Promise<void> {
    /* no-op */
  }
}

/** The boot reconciliation outcome (the regime-desk semantics, carry-flavoured). */
export interface CarryResumePlan {
  /** Gated today AND a persisted OPEN record exists ⇒ restore + resume the held pair. */
  readonly resume: CarryBookRecord[];
  /** Gated today, no persisted record ⇒ open fresh. */
  readonly startFlat: string[];
  /** A persisted OPEN record whose symbol FAILS today's gate ⇒ the carry de-validated
   *  (or the recency veto fired) — close it at market, don't ride it (the #72 lesson). */
  readonly orphaned: CarryBookRecord[];
}

/**
 * Pure boot reconciliation (no I/O): today's freshly-gated eligible set vs the persisted
 * OPEN records. A resumed record whose persisted DIRECTION disagrees with today's gated
 * direction is treated as ORPHANED too — the funding side flipped across the restart.
 */
export function reconcileCarryResume(
  eligible: readonly { symbol: string; direction: CarryDirection }[],
  open: readonly CarryBookRecord[],
): CarryResumePlan {
  const eligBySym = new Map(eligible.map((e) => [e.symbol.toUpperCase(), e.direction]));
  const openBySym = new Map(open.map((r) => [r.symbol.toUpperCase(), r]));
  const resume: CarryBookRecord[] = [];
  const startFlat: string[] = [];
  const orphaned: CarryBookRecord[] = [];
  for (const { symbol, direction } of eligible) {
    const rec = openBySym.get(symbol.toUpperCase());
    if (rec && rec.direction === direction) resume.push(rec);
    else {
      if (rec) orphaned.push(rec); // direction flipped ⇒ close the old pair, open fresh
      startFlat.push(symbol);
    }
  }
  for (const rec of open) {
    if (!eligBySym.has(rec.symbol.toUpperCase())) orphaned.push(rec);
  }
  return { resume, startFlat, orphaned };
}
