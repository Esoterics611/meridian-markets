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

// ── Phase 1: hedge table privilege assertions ─────────────────────────────────
// Same oracle as treasury: meridian_markets_app must have SELECT,INSERT only on
// hedge_movements (append-only) and SELECT,INSERT,UPDATE on hedge_positions.
describeIfDb('INTEGRATION: hedge_movements is append-only for meridian_markets_app', () => {
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

  it('meridian_markets_app MAY SELECT and INSERT hedge_movements', async () => {
    if (!dbUp) return;
    expect(await may('hedge_movements', 'SELECT')).toBe(true);
    expect(await may('hedge_movements', 'INSERT')).toBe(true);
  });

  it('meridian_markets_app may NOT UPDATE or DELETE hedge_movements', async () => {
    if (!dbUp) return;
    expect(await may('hedge_movements', 'UPDATE')).toBe(false);
    expect(await may('hedge_movements', 'DELETE')).toBe(false);
  });

  it('hedge_positions IS mutable (SELECT, INSERT, UPDATE) but not deletable', async () => {
    if (!dbUp) return;
    expect(await may('hedge_positions', 'SELECT')).toBe(true);
    expect(await may('hedge_positions', 'INSERT')).toBe(true);
    expect(await may('hedge_positions', 'UPDATE')).toBe(true);
    expect(await may('hedge_positions', 'DELETE')).toBe(false);
  });

  it('hedge_movements CHECK rejects an invalid direction value', async () => {
    if (!dbUp) return;
    await expect(
      ds.query(
        `INSERT INTO hedge_movements
           (venue, direction, notional_units, external_ref, idempotency_key)
         VALUES ('mock', 'BAD_DIRECTION', 1000, 'ext', 'chk-bad-dir-${Math.random()}')`,
      ),
    ).rejects.toThrow();
  });
});

// ── Phase 3: stat-arb table privilege assertions ──────────────────────────────
// Same oracle as treasury / hedge: meridian_markets_app must have SELECT,INSERT
// only on both stat_arb_trades and stat_arb_nav. No UPDATE or DELETE.
describeIfDb('INTEGRATION: stat_arb_trades and stat_arb_nav are append-only', () => {
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

  it('meridian_markets_app MAY SELECT and INSERT stat_arb_trades / stat_arb_nav', async () => {
    if (!dbUp) return;
    expect(await may('stat_arb_trades', 'SELECT')).toBe(true);
    expect(await may('stat_arb_trades', 'INSERT')).toBe(true);
    expect(await may('stat_arb_nav', 'SELECT')).toBe(true);
    expect(await may('stat_arb_nav', 'INSERT')).toBe(true);
  });

  it('meridian_markets_app may NOT UPDATE or DELETE stat_arb_trades', async () => {
    if (!dbUp) return;
    expect(await may('stat_arb_trades', 'UPDATE')).toBe(false);
    expect(await may('stat_arb_trades', 'DELETE')).toBe(false);
  });

  it('meridian_markets_app may NOT UPDATE or DELETE stat_arb_nav', async () => {
    if (!dbUp) return;
    expect(await may('stat_arb_nav', 'UPDATE')).toBe(false);
    expect(await may('stat_arb_nav', 'DELETE')).toBe(false);
  });

  it('stat_arb_trades CHECK rejects non-positive notional', async () => {
    if (!dbUp) return;
    await expect(
      ds.query(
        `INSERT INTO stat_arb_trades
           (venue, symbol_a, symbol_b, side,
            entry_z, exit_z,
            entry_price_a_micros, entry_price_b_micros,
            exit_price_a_micros, exit_price_b_micros,
            notional_units, pnl_units, fees_units,
            opened_at, closed_at, idempotency_key)
         VALUES
           ('mock','BTC','ETH','SHORT',
            1.5, 0.2,
            1, 1, 1, 1,
            0, 0, 0,
            NOW(), NOW(), 'chk-${Math.random()}')`,
      ),
    ).rejects.toThrow();
  });
});
