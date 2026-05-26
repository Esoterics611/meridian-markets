import { DataSource } from 'typeorm';
import {
  describeIfDb,
  dbAvailableCached,
  newPrivilegedDataSource,
} from '../test-helpers/postgres-available';

// LOAD-BEARING INVARIANT: the application role `meridian_markets_app` has
// SELECT,INSERT only on treasury_movements — UPDATE/DELETE are revoked, so
// the treasury ledger is append-only at the database privilege layer (not
// merely by code discipline). Asserted against the real Postgres grant
// catalog. This is the regression oracle for every later schema change.
describeIfDb('INTEGRATION: treasury_movements is append-only for meridian_markets_app', () => {
  let ds: DataSource;
  let dbUp = false;

  beforeAll(async () => {
    dbUp = await dbAvailableCached();
    if (!dbUp) return;
    ds = newPrivilegedDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    if (dbUp && ds) await ds.destroy();
  });

  async function may(table: string, priv: string): Promise<boolean> {
    const rows = await ds.query<{ ok: boolean }[]>(
      `SELECT has_table_privilege('meridian_markets_app', $1, $2) AS ok`,
      [table, priv],
    );
    return rows[0].ok === true;
  }

  it('meridian_markets_app MAY SELECT and INSERT treasury_movements', async () => {
    if (!dbUp) return;
    expect(await may('treasury_movements', 'SELECT')).toBe(true);
    expect(await may('treasury_movements', 'INSERT')).toBe(true);
  });

  it('meridian_markets_app may NOT UPDATE or DELETE treasury_movements', async () => {
    if (!dbUp) return;
    expect(await may('treasury_movements', 'UPDATE')).toBe(false);
    expect(await may('treasury_movements', 'DELETE')).toBe(false);
  });

  it('control: treasury_positions IS mutable (the oracle discriminates)', async () => {
    if (!dbUp) return;
    expect(await may('treasury_positions', 'SELECT')).toBe(true);
    expect(await may('treasury_positions', 'INSERT')).toBe(true);
    expect(await may('treasury_positions', 'UPDATE')).toBe(true);
    // We deliberately did NOT grant DELETE — positions are cache rows, not
    // garbage. Deletion would lose the "last known yield" signal.
    expect(await may('treasury_positions', 'DELETE')).toBe(false);
  });

  it('the CHECK constraint rejects non-positive amounts', async () => {
    if (!dbUp) return;
    await expect(
      ds.query(
        `INSERT INTO treasury_movements (direction, amount_usdc_units, provider, idempotency_key, running_balance_units)
         VALUES ('DEPOSIT', 0, 'unit-test', 'chk-${Math.random()}', 0)`,
      ),
    ).rejects.toThrow();
  });
});
