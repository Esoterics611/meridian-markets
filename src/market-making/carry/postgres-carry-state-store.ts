import { DataSource } from 'typeorm';
import { CarryBookRecord, CarryNavInsert, ICarryStateStore } from './carry-state-store';

// PostgresCarryStateStore — the real persistence backend for the carry desk (P0),
// mirroring PostgresRegimeStateStore byte-for-byte in posture: takes a TypeORM
// DataSource directly (no Nest context — the standalone runner uses the app-role
// DATABASE_URL_APP), raw SQL, migrations own the schema (CLAUDE.md §2).
//
// carry_book_state is a MUTABLE checkpoint cache (one row per symbol; upsert;
// soft-close). mm_nav is APPEND-ONLY; the carry desk writes desk='carry' under a
// '@carry' book_key namespace so its curve never collides with the MM ('' / 'SYMBOL')
// or regime ('@regime…') desks in the one shared table.

/** desk='carry' book_key namespace: '@carry' = the desk aggregate, '@carry:SYM' per book. */
function navKey(bookKey: string): string {
  return bookKey === '' ? '@carry' : `@carry:${bookKey.toUpperCase()}`;
}

export class PostgresCarryStateStore implements ICarryStateStore {
  readonly enabled = true;
  constructor(private readonly ds: DataSource) {}

  async saveBook(r: CarryBookRecord): Promise<void> {
    await this.ds.query(
      `INSERT INTO carry_book_state (symbol, direction, gate_annualized_pct, entry_ms, status, state, updated_at)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, NOW())
       ON CONFLICT (symbol) DO UPDATE SET
         direction = EXCLUDED.direction, gate_annualized_pct = EXCLUDED.gate_annualized_pct,
         entry_ms = EXCLUDED.entry_ms, status = 'OPEN', state = EXCLUDED.state, updated_at = NOW()`,
      [r.symbol.toUpperCase(), r.direction, r.gateAnnualizedPct, r.entryMs, JSON.stringify(r.state)],
    );
  }

  async loadOpen(): Promise<CarryBookRecord[]> {
    const rows = await this.ds.query<
      { symbol: string; direction: string; gate_annualized_pct: number; entry_ms: string | null; state: unknown }[]
    >(`SELECT symbol, direction, gate_annualized_pct, entry_ms, state FROM carry_book_state WHERE status = 'OPEN' ORDER BY symbol`);
    return rows.map((row) => ({
      symbol: row.symbol,
      direction: row.direction as CarryBookRecord['direction'],
      gateAnnualizedPct: Number(row.gate_annualized_pct),
      entryMs: row.entry_ms === null ? null : Number(row.entry_ms),
      // JSONB comes back already parsed by the pg driver; tolerate a string just in case.
      state: typeof row.state === 'string' ? JSON.parse(row.state) : (row.state as CarryBookRecord['state']),
    }));
  }

  async closeBook(symbol: string): Promise<void> {
    await this.ds.query(`UPDATE carry_book_state SET status = 'CLOSED', updated_at = NOW() WHERE symbol = $1`, [
      symbol.toUpperCase(),
    ]);
  }

  async appendNav(rows: CarryNavInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const COLS = 10; // 10 bound params/row; the desk tag ('carry') is an inlined literal.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    rows.forEach((r, i) => {
      const b = i * COLS;
      placeholders.push(
        `($${b + 1}, 'carry', $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`,
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
