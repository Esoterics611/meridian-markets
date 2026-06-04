import { Injectable } from '@nestjs/common';
import { DbService } from '@database/db.service';

// Raw-SQL repository for mm_nav — the append-only MM NAV / equity-curve time
// series (Telemetry P3, the durable research deliverable). Same shape as
// StatArbRepository / MmStateRepository: TypeORM is a connection pool, migrations
// own the schema, no entity decorators. Money/P&L in 6-decimal USDC units,
// inventory in 6-decimal asset units — all BIGINT in the DB, bigint in TS,
// decimal strings on the wire (coerced back on read).

/** One NAV row to persist. `bookKey = ''` ⇒ the desk-aggregate row. */
export interface MmNavInsert {
  asOf: Date;
  /** '' = desk aggregate (matches meridian_desk_nav_units); else a per-book symbol. */
  bookKey: string;
  equityUnits: bigint;
  netPnlUnits: bigint;
  realisedPnlUnits: bigint;
  unrealisedPnlUnits: bigint;
  feesUnits: bigint;
  fundingUnits: bigint;
  inventoryUnits: bigint;
  maxDrawdownPct: number;
}

export interface MmNavRow extends MmNavInsert {
  id: string;
  createdAt: Date;
}

// Column order shared by the batch INSERT and the placeholder builder.
const COLS = 10; // as_of, book_key, + 7 bigint metrics + max_drawdown_pct

@Injectable()
export class MmNavRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert a batch of NAV rows (one desk row + per-book rows for an interval) in a
   * SINGLE serializable transaction so the whole snapshot lands atomically — a
   * reader never sees a desk row without its books. Append-only: no idempotency
   * key, no ON CONFLICT — every interval is a fresh row. Returns rows inserted.
   */
  async insertNavSnapshot(rows: MmNavInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.runInSerializableTransaction(async (em) => {
      const placeholders: string[] = [];
      const params: unknown[] = [];
      rows.forEach((r, i) => {
        const base = i * COLS;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
            `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
        );
        params.push(
          r.asOf,
          r.bookKey,
          r.equityUnits.toString(),
          r.netPnlUnits.toString(),
          r.realisedPnlUnits.toString(),
          r.unrealisedPnlUnits.toString(),
          r.feesUnits.toString(),
          r.fundingUnits.toString(),
          r.inventoryUnits.toString(),
          r.maxDrawdownPct,
        );
      });
      const inserted = await em.query<{ id: string }[]>(
        `INSERT INTO mm_nav (
           as_of, book_key, equity_units, net_pnl_units, realised_pnl_units,
           unrealised_pnl_units, fees_units, funding_units, inventory_units, max_drawdown_pct
         ) VALUES ${placeholders.join(', ')}
         RETURNING id`,
        params,
      );
      return inserted.length;
    });
  }

  /**
   * The equity curve for one series since `fromAsOf`, oldest-first (chart order).
   * `bookKey` defaults to '' — the desk-aggregate curve; pass a symbol for a book.
   */
  async navHistory(fromAsOf: Date, bookKey = ''): Promise<MmNavRow[]> {
    return this.db.runInSerializableTransaction(async (em) => {
      const rows = await em.query<MmNavRow[]>(
        `SELECT id, as_of AS "asOf", book_key AS "bookKey",
                equity_units AS "equityUnits", net_pnl_units AS "netPnlUnits",
                realised_pnl_units AS "realisedPnlUnits", unrealised_pnl_units AS "unrealisedPnlUnits",
                fees_units AS "feesUnits", funding_units AS "fundingUnits",
                inventory_units AS "inventoryUnits", max_drawdown_pct AS "maxDrawdownPct",
                created_at AS "createdAt"
         FROM mm_nav
         WHERE book_key = $1 AND as_of >= $2
         ORDER BY as_of ASC`,
        [bookKey, fromAsOf],
      );
      return rows.map((r) => this.coerce(r));
    });
  }

  /** Coerce driver-returned numeric strings into bigints + Dates. */
  private coerce(r: MmNavRow): MmNavRow {
    return {
      ...r,
      equityUnits: BigInt(r.equityUnits as unknown as string),
      netPnlUnits: BigInt(r.netPnlUnits as unknown as string),
      realisedPnlUnits: BigInt(r.realisedPnlUnits as unknown as string),
      unrealisedPnlUnits: BigInt(r.unrealisedPnlUnits as unknown as string),
      feesUnits: BigInt(r.feesUnits as unknown as string),
      fundingUnits: BigInt(r.fundingUnits as unknown as string),
      inventoryUnits: BigInt(r.inventoryUnits as unknown as string),
      maxDrawdownPct: Number(r.maxDrawdownPct),
      asOf: new Date(r.asOf),
      createdAt: new Date(r.createdAt),
    };
  }
}
