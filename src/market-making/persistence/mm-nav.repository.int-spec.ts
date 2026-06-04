import { DataSource } from 'typeorm';
import { DbService } from '@database/db.service';
import { MmNavRepository, MmNavInsert } from './mm-nav.repository';
import {
  describeIfDb,
  dbAvailableCached,
  newAppDataSource,
} from '../../test-helpers/postgres-available';

// DB-gated round-trip against real Postgres (the meridian_markets_app role, which
// has SELECT,INSERT only on mm_nav). Each run uses a unique book_key so the
// append-only table never needs cleanup and runs never collide. Mirrors the
// treasury / hedge integration-spec shape; auto-skips when the DB is unreachable.
describeIfDb('INTEGRATION: MmNavRepository against real Postgres', () => {
  let ds: DataSource;
  let db: DbService;
  let dbUp = false;
  const key = `it-nav-${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    dbUp = await dbAvailableCached();
    if (!dbUp) return;
    ds = newAppDataSource();
    await ds.initialize();
    db = new DbService(ds);
  });

  afterAll(async () => {
    if (dbUp && ds) await ds.destroy();
  });

  function row(asOf: Date, over: Partial<MmNavInsert> = {}): MmNavInsert {
    return {
      asOf,
      bookKey: key,
      equityUnits: 100_000_000_000n,
      netPnlUnits: 0n,
      realisedPnlUnits: 0n,
      unrealisedPnlUnits: 0n,
      feesUnits: 0n,
      fundingUnits: 0n,
      inventoryUnits: 0n,
      maxDrawdownPct: 0,
      ...over,
    };
  }

  it('insertNavSnapshot writes the batch and navHistory reads it back oldest-first with bigints/signs intact', async () => {
    if (!dbUp) return;
    const t0 = new Date('2026-06-04T00:00:00Z');
    const t1 = new Date('2026-06-04T00:01:00Z');
    const repo = new MmNavRepository(db);
    const n = await repo.insertNavSnapshot([
      // Insert out of order on purpose — navHistory must sort by as_of ASC.
      row(t1, { equityUnits: 100_000_500_000n, netPnlUnits: 500_000n, feesUnits: -2_000n, inventoryUnits: 791_600n, maxDrawdownPct: 0.53 }),
      row(t0, { equityUnits: 100_000_000_000n }),
    ]);
    expect(n).toBe(2);

    const rows = await repo.navHistory(new Date('2026-06-03T00:00:00Z'), key);
    expect(rows).toHaveLength(2);
    expect(rows[0].asOf.getTime()).toBeLessThan(rows[1].asOf.getTime()); // ASC
    expect(rows[0].equityUnits).toBe(100_000_000_000n);
    expect(typeof rows[1].equityUnits).toBe('bigint');
    expect(rows[1].equityUnits).toBe(100_000_500_000n);
    expect(rows[1].feesUnits).toBe(-2_000n); // signed rebate survives the round-trip
    expect(rows[1].inventoryUnits).toBe(791_600n);
    expect(rows[1].maxDrawdownPct).toBeCloseTo(0.53);
  });

  it('navHistory returns [] for a key with no rows', async () => {
    if (!dbUp) return;
    const rows = await new MmNavRepository(db).navHistory(new Date('2026-06-03T00:00:00Z'), `${key}-absent`);
    expect(rows).toEqual([]);
  });

  it('insertNavSnapshot is a no-op for an empty batch (no txn opened)', async () => {
    if (!dbUp) return;
    expect(await new MmNavRepository(db).insertNavSnapshot([])).toBe(0);
  });
});
