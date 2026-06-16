import { DataSource } from 'typeorm';
import { PostgresRegimeStateStore } from './postgres-regime-state-store';
import { RegimeBookRecord, RegimeNavInsert } from './regime-state-store';
import { describeIfDb, dbAvailableCached, newAppDataSource } from '../../test-helpers/postgres-available';

// DB-gated round-trip against real Postgres (the meridian_markets_app role). A unique symbol
// per run keeps the test isolated; mm_nav is append-only so no cleanup is needed. Auto-skips
// when the DB is unreachable (CI starts Postgres + runs migrations first). Mirrors the
// mm-nav / mm-state integration-spec shape.
describeIfDb('INTEGRATION: PostgresRegimeStateStore against real Postgres', () => {
  let ds: DataSource;
  let store: PostgresRegimeStateStore;
  let dbUp = false;
  const sym = `IT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  beforeAll(async () => {
    dbUp = await dbAvailableCached();
    if (!dbUp) return;
    ds = newAppDataSource();
    await ds.initialize();
    store = new PostgresRegimeStateStore(ds);
  });

  afterAll(async () => {
    if (dbUp && ds) await ds.destroy();
  });

  function record(over: Partial<RegimeBookRecord> = {}): RegimeBookRecord {
    return {
      symbol: sym,
      signal: 'momentum(24h)',
      ic: 0.27,
      entryMidMicros: '65000000000',
      entryMs: 1_700_000_000_000,
      state: {
        book: { inventoryUnits: '209400', avgCostMicros: '65000000000', realisedUnits: '0', feesUnits: '6190', fillCount: 1 },
        fundingAccruedUnits: '1234',
        lastMs: 1_700_000_000_000,
      },
      ...over,
    };
  }

  it('saveBook → loadOpen round-trips the record exactly', async () => {
    if (!dbUp) return;
    await store.saveBook(record());
    const open = await store.loadOpen();
    const got = open.find((r) => r.symbol === sym);
    expect(got).toBeDefined();
    expect(got!.signal).toBe('momentum(24h)');
    expect(got!.ic).toBeCloseTo(0.27);
    expect(got!.entryMidMicros).toBe('65000000000');
    expect(got!.entryMs).toBe(1_700_000_000_000);
    expect(got!.state).toEqual(record().state); // the JSONB ledger blob is exact
  });

  it('upsert overwrites the prior checkpoint (mutable cache)', async () => {
    if (!dbUp) return;
    await store.saveBook(record({ state: { ...record().state, fundingAccruedUnits: '9999' } }));
    const got = (await store.loadOpen()).find((r) => r.symbol === sym);
    expect(got!.state.fundingAccruedUnits).toBe('9999');
  });

  it('closeBook soft-closes the row (no longer OPEN)', async () => {
    if (!dbUp) return;
    await store.closeBook(sym);
    const open = await store.loadOpen();
    expect(open.find((r) => r.symbol === sym)).toBeUndefined();
  });

  it('appendNav writes regime-tagged rows under the @regime namespace', async () => {
    if (!dbUp) return;
    const navRow: RegimeNavInsert = {
      asOf: new Date(),
      bookKey: sym,
      equityUnits: 1_000_000_000n,
      realisedPnlUnits: 500_000n,
      unrealisedPnlUnits: 0n,
      feesUnits: 6_190n,
      fundingUnits: 1_234n,
      inventoryUnits: 209_400n,
      maxDrawdownPct: 0.12,
    };
    await store.appendNav([navRow]);
    const rows = await ds.query(
      `SELECT desk, book_key FROM mm_nav WHERE desk = 'regime' AND book_key = $1 ORDER BY as_of DESC LIMIT 1`,
      [`@regime:${sym}`],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].desk).toBe('regime');
  });
});
