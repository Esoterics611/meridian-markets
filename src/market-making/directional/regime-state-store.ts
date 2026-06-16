import { RegimeBookState } from './regime-directional-book';

// IRegimeStateStore — the persistence seam for the "take sides" desk (Playbook II P6,
// CLAUDE.md §7). A NullRegimeStateStore (no-op, the default) keeps DB-free runs + tests
// behaving exactly as before; a PostgresRegimeStateStore checkpoints each book to
// regime_book_state and the desk equity to mm_nav (tagged desk='regime') so the track
// record survives a crash/restart. Selected by config (MM_PERSIST), exactly like the MM
// desk's IMmStateStore — the regime desk is a *separate desk* that shares the one DB.
//
// What is durable vs rebuilt (mirrors the MM seam): the SIGNAL machinery (consensus,
// monitor, gate) is rebuilt fresh from today's validated board on boot; only the evolving
// P&L STATE + the position's entry context are persisted. So a restart resumes the carried
// position rather than re-opening from flat — an unrecoverable paper run is not a track record.

/** A book's full durable record: enough to resume its position on boot. */
export interface RegimeBookRecord {
  /** Symbol = the row PK (one book per symbol). */
  readonly symbol: string;
  /** Which validated signal drove the position (for the resume reconciliation log). */
  readonly signal: string;
  /** The OOS IC carried for conviction sizing. */
  readonly ic: number;
  /** Entry mark (price micros) — null when flat. Decimal string (JSONB/BIGINT-safe). */
  readonly entryMidMicros: string | null;
  /** Entry epoch ms — null when flat. */
  readonly entryMs: number | null;
  /** The evolving ledger + accumulators (RegimeDirectionalBook.serializeState()). */
  readonly state: RegimeBookState;
}

/** One desk/per-book equity-curve row for mm_nav (desk='regime'). */
export interface RegimeNavInsert {
  readonly asOf: Date;
  /** '' = the regime desk aggregate; else a symbol. The store namespaces it under '@regime'. */
  readonly bookKey: string;
  readonly equityUnits: bigint;
  readonly realisedPnlUnits: bigint;
  readonly unrealisedPnlUnits: bigint;
  readonly feesUnits: bigint;
  readonly fundingUnits: bigint;
  readonly inventoryUnits: bigint;
  readonly maxDrawdownPct: number;
}

export interface IRegimeStateStore {
  /** True when persistence is active (NullRegimeStateStore ⇒ false). */
  readonly enabled: boolean;
  /** Insert-or-update a book's state checkpoint (status ⇒ OPEN). */
  saveBook(record: RegimeBookRecord): Promise<void>;
  /** All OPEN book records, for boot rehydration. */
  loadOpen(): Promise<RegimeBookRecord[]>;
  /** Soft-close a book (status=CLOSED), keeping its row + final P&L. */
  closeBook(symbol: string): Promise<void>;
  /** Append a batch of equity-curve rows (desk row + per-book rows) — append-only. */
  appendNav(rows: RegimeNavInsert[]): Promise<void>;
}

/** The safe default: persistence off, every call a no-op. DB-free runs are unchanged. */
export class NullRegimeStateStore implements IRegimeStateStore {
  readonly enabled = false;
  async saveBook(_record: RegimeBookRecord): Promise<void> {
    /* no-op */
  }
  async loadOpen(): Promise<RegimeBookRecord[]> {
    return [];
  }
  async closeBook(_symbol: string): Promise<void> {
    /* no-op */
  }
  async appendNav(_rows: RegimeNavInsert[]): Promise<void> {
    /* no-op */
  }
}

/** The boot reconciliation outcome: which persisted books to resume vs start fresh vs drop. */
export interface ResumePlan {
  /** Eligible today AND a persisted OPEN record exists ⇒ restore + resume. */
  readonly resume: RegimeBookRecord[];
  /** Eligible today, no persisted record ⇒ start flat. */
  readonly startFlat: string[];
  /** A persisted OPEN record whose symbol is NOT eligible today ⇒ the signal de-validated;
   *  do NOT resume (don't ride a position the gate no longer justifies) — close the row. */
  readonly orphaned: RegimeBookRecord[];
}

/**
 * Pure boot reconciliation (no I/O): given today's freshly-gated eligible set and the
 * persisted OPEN records, decide what to resume, what to start flat, and what to drop.
 * A symbol that validated yesterday but not today is ORPHANED — the BNB lesson (#72):
 * regimes shift over weeks, so a stale position is closed, not ridden.
 */
export function reconcileResume(eligible: readonly string[], open: readonly RegimeBookRecord[]): ResumePlan {
  const eligSet = new Set(eligible.map((s) => s.toUpperCase()));
  const bySym = new Map(open.map((r) => [r.symbol.toUpperCase(), r]));
  const resume: RegimeBookRecord[] = [];
  const startFlat: string[] = [];
  for (const sym of eligible) {
    const rec = bySym.get(sym.toUpperCase());
    if (rec) resume.push(rec);
    else startFlat.push(sym);
  }
  const orphaned = open.filter((r) => !eligSet.has(r.symbol.toUpperCase()));
  return { resume, startFlat, orphaned };
}
