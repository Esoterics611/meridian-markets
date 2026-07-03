import { DataSource } from 'typeorm';
import { PostgresCarryStateStore } from './postgres-carry-state-store';
import { CarryBookRecord, CarryNavInsert } from './carry-state-store';
import { FundingCarryBook } from './funding-carry-book';
import { describeIfDb, dbAvailableCached, newAppDataSource } from '../../test-helpers/postgres-available';

// DB-gated round-trip against real Postgres (the meridian_markets_app role).
// Auto-skips when the DB is unreachable. Mirrors postgres-regime-state-store.int-spec.
//
// FIXTURE HYGIENE (#93): the symbol is the FIXED well-known 'ITFIXTURE', not a random
// one — the app role has no DELETE on carry_book_state, so a random symbol per run
// leaked one CLOSED row into the real paper DB per run (ITA5NED7 was one). A fixed
// symbol upserts the same single row forever (bounded), and CarryReadService excludes
// exactly this symbol from every read (CARRY_TEST_FIXTURE_SYMBOL).
describeIfDb('INTEGRATION: PostgresCarryStateStore against real Postgres', () => {
  let ds: DataSource;
  let store: PostgresCarryStateStore;
  let dbUp = false;
  const sym = 'ITFIXTURE';

  beforeAll(async () => {
    dbUp = await dbAvailableCached();
    if (!dbUp) return;
    ds = newAppDataSource();
    await ds.initialize();
    store = new PostgresCarryStateStore(ds);
  });

  afterAll(async () => {
    if (dbUp && ds) await ds.destroy();
  });

  function record(over: Partial<CarryBookRecord> = {}): CarryBookRecord {
    const book = new FundingCarryBook({
      symbol: sym,
      direction: 'SHORT_PERP',
      notionalUsd: 50_000,
      spotFeeBps: 4.5,
      perpFeeBps: 2.5,
      fundingPeriodMs: 3_600_000,
    });
    book.open(1_700_000_000_000, 3_000_000_000n, 2_998_800_000n);
    return { symbol: sym, direction: 'SHORT_PERP', gateAnnualizedPct: 8.1, entryMs: 1_700_000_000_000, state: book.serializeState(), ...over };
  }

  it('saveBook → loadOpen round-trips the record exactly (and the revived book accrues correctly)', async () => {
    if (!dbUp) return;
    const rec = record();
    await store.saveBook(rec);
    const got = (await store.loadOpen()).find((r) => r.symbol === sym);
    expect(got).toBeDefined();
    expect(got!.direction).toBe('SHORT_PERP');
    expect(got!.gateAnnualizedPct).toBeCloseTo(8.1);
    expect(got!.entryMs).toBe(1_700_000_000_000);
    expect(got!.state).toEqual(rec.state); // the JSONB two-leg ledger is exact
    // The DB round-trip preserves the accrual clock (the #47 trap, through Postgres).
    const revived = new FundingCarryBook({
      symbol: sym,
      direction: 'SHORT_PERP',
      notionalUsd: 50_000,
      spotFeeBps: 4.5,
      perpFeeBps: 2.5,
      fundingPeriodMs: 3_600_000,
    });
    revived.restoreState(got!.state);
    const delta = revived.accrueFunding(1_700_000_000_000 + 3_600_000, 0.0000125, 2_998_800_000n);
    expect(Number(delta) / 1e6).toBeCloseTo(0.625, 2); // exactly 1h at 0.125bps on $50k
  });

  it('upsert overwrites the prior checkpoint (mutable cache)', async () => {
    if (!dbUp) return;
    const rec = record();
    await store.saveBook({ ...rec, state: { ...rec.state, fundingUnits: '9999' } });
    const got = (await store.loadOpen()).find((r) => r.symbol === sym);
    expect(got!.state.fundingUnits).toBe('9999');
  });

  it('closeBook soft-closes the row (no longer OPEN)', async () => {
    if (!dbUp) return;
    await store.closeBook(sym);
    expect((await store.loadOpen()).find((r) => r.symbol === sym)).toBeUndefined();
  });

  it('appendNav writes carry-tagged rows under the @carry namespace', async () => {
    if (!dbUp) return;
    const navRow: CarryNavInsert = {
      asOf: new Date(),
      bookKey: sym,
      equityUnits: 50_000_000_000n,
      realisedPnlUnits: 0n,
      unrealisedPnlUnits: 12_000n,
      feesUnits: 35_000_000n,
      fundingUnits: 625_000n,
      inventoryUnits: 16_670_000n,
      maxDrawdownPct: 0.05,
    };
    await store.appendNav([navRow]);
    const rows = await ds.query(
      `SELECT desk, book_key FROM mm_nav WHERE desk = 'carry' AND book_key = $1 ORDER BY as_of DESC LIMIT 1`,
      [`@carry:${sym}`],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].desk).toBe('carry');
  });
});
