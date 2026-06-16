import { DataSource } from 'typeorm';
import { IRegimeStateStore, RegimeBookRecord, RegimeNavInsert } from './regime-state-store';

// PostgresRegimeStateStore — the real persistence backend for the "take sides" desk (P6).
// It takes a TypeORM DataSource directly (NOT the Nest DbService) so the standalone runner
// scripts/regime-book-live.ts can use it without a Nest context — the app-role DataSource is
// built from DATABASE_URL_APP, the same role + grants the live service uses (SELECT,INSERT,
// UPDATE on regime_book_state; SELECT,INSERT on mm_nav). Raw SQL, migrations own the schema,
// no entity decorators — the repo-wide discipline (CLAUDE.md §2).
//
// regime_book_state is a MUTABLE checkpoint cache (one row per symbol; upsert; soft-close).
// mm_nav is APPEND-ONLY; the regime desk writes there with desk='regime' and a '@regime'
// book_key namespace so its curve never collides with the MM desk's (book_key '' / 'SYMBOL').

/** desk='regime' book_key namespace: '@regime' = the desk aggregate, '@regime:SYM' per book. */
function navKey(bookKey: string): string {
  return bookKey === '' ? '@regime' : `@regime:${bookKey.toUpperCase()}`;
}

export class PostgresRegimeStateStore implements IRegimeStateStore {
  readonly enabled = true;
  constructor(private readonly ds: DataSource) {}

  async saveBook(r: RegimeBookRecord): Promise<void> {
    await this.ds.query(
      `INSERT INTO regime_book_state (symbol, signal, ic, entry_mid_micros, entry_ms, status, state, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, NOW())
       ON CONFLICT (symbol) DO UPDATE SET
         signal = EXCLUDED.signal, ic = EXCLUDED.ic,
         entry_mid_micros = EXCLUDED.entry_mid_micros, entry_ms = EXCLUDED.entry_ms,
         status = 'OPEN', state = EXCLUDED.state, updated_at = NOW()`,
      [r.symbol.toUpperCase(), r.signal, r.ic, r.entryMidMicros, r.entryMs, JSON.stringify(r.state)],
    );
  }

  async loadOpen(): Promise<RegimeBookRecord[]> {
    const rows = await this.ds.query<
      { symbol: string; signal: string; ic: number; entry_mid_micros: string | null; entry_ms: string | null; state: unknown }[]
    >(
      `SELECT symbol, signal, ic, entry_mid_micros, entry_ms, state
         FROM regime_book_state WHERE status = 'OPEN' ORDER BY symbol`,
    );
    return rows.map((row) => ({
      symbol: row.symbol,
      signal: row.signal,
      ic: Number(row.ic),
      entryMidMicros: row.entry_mid_micros === null ? null : String(row.entry_mid_micros),
      entryMs: row.entry_ms === null ? null : Number(row.entry_ms),
      // JSONB comes back already parsed by the pg driver; tolerate a string just in case.
      state: typeof row.state === 'string' ? JSON.parse(row.state) : (row.state as RegimeBookRecord['state']),
    }));
  }

  async closeBook(symbol: string): Promise<void> {
    await this.ds.query(`UPDATE regime_book_state SET status = 'CLOSED', updated_at = NOW() WHERE symbol = $1`, [
      symbol.toUpperCase(),
    ]);
  }

  async appendNav(rows: RegimeNavInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const COLS = 10; // 10 bound params/row; the desk tag ('regime') is an inlined literal.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    rows.forEach((r, i) => {
      const b = i * COLS;
      placeholders.push(
        `($${b + 1}, 'regime', $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`,
      );
      // net_pnl = realised − fees + funding + unrealised (the desk's total-P&L reading).
      const netPnl = r.realisedPnlUnits - r.feesUnits + r.fundingUnits + r.unrealisedPnlUnits;
      params.push(
        r.asOf,
        navKey(r.bookKey),
        r.equityUnits.toString(),
        netPnl.toString(),
        r.realisedPnlUnits.toString(),
        r.unrealisedPnlUnits.toString(),
        r.feesUnits.toString(),
        r.fundingUnits.toString(),
        r.inventoryUnits.toString(),
        r.maxDrawdownPct,
      );
    });
    await this.ds.query(
      `INSERT INTO mm_nav (
         as_of, desk, book_key, equity_units, net_pnl_units, realised_pnl_units,
         unrealised_pnl_units, fees_units, funding_units, inventory_units, max_drawdown_pct
       ) VALUES ${placeholders.join(', ')}`,
      params,
    );
  }
}
