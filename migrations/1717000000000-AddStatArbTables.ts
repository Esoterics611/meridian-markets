import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — Phase 3 stat-arb persistence schema.
//
// Two tables, same posture as Phase 0 (treasury_movements) and Phase 1
// (hedge_movements):
//
//   stat_arb_trades  — APPEND-ONLY ledger of every closed round-trip pairs
//                      trade. meridian_markets_app has SELECT,INSERT only —
//                      no UPDATE, no DELETE, ever. Unique on (venue,
//                      idempotency_key) for replay safety.
//
//   stat_arb_nav     — APPEND-ONLY snapshot of strategy NAV per UTC day.
//                      Written by the NAV cron; idempotent per day via a
//                      partial UNIQUE index. Same shape as the YIELD_ACCRUAL
//                      idempotency pattern.
//
// Notional and P&L in 6-decimal USDC units (BIGINT). Prices in micros (1e6).
// Same conventions used everywhere else in the repo.

export class AddStatArbTables1717000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // ── stat_arb_trades (append-only) ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE stat_arb_trades (
        id                       BIGSERIAL    PRIMARY KEY,
        venue                    TEXT         NOT NULL,
        symbol_a                 TEXT         NOT NULL,
        symbol_b                 TEXT         NOT NULL,
        side                     TEXT         NOT NULL,
        entry_z                  DOUBLE PRECISION NOT NULL,
        exit_z                   DOUBLE PRECISION NOT NULL,
        entry_price_a_micros     BIGINT       NOT NULL,
        entry_price_b_micros     BIGINT       NOT NULL,
        exit_price_a_micros      BIGINT       NOT NULL,
        exit_price_b_micros      BIGINT       NOT NULL,
        notional_units           BIGINT       NOT NULL,
        pnl_units                BIGINT       NOT NULL,
        fees_units               BIGINT       NOT NULL,
        opened_at                TIMESTAMPTZ  NOT NULL,
        closed_at                TIMESTAMPTZ  NOT NULL,
        idempotency_key          TEXT         NOT NULL,
        created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_sat_side  CHECK (side IN ('LONG','SHORT')),
        CONSTRAINT chk_sat_notional CHECK (notional_units > 0),
        CONSTRAINT chk_sat_fees   CHECK (fees_units >= 0),
        CONSTRAINT uniq_sat_idempotency UNIQUE (venue, idempotency_key)
      )
    `);

    // Recent-trades lookup for the dashboard.
    await queryRunner.query(`
      CREATE INDEX idx_stat_arb_trades_recent
        ON stat_arb_trades (venue, closed_at DESC)
    `);

    // ── stat_arb_nav (append-only daily snapshot) ────────────────────────────
    await queryRunner.query(`
      CREATE TABLE stat_arb_nav (
        id                  BIGSERIAL    PRIMARY KEY,
        as_of               TIMESTAMPTZ  NOT NULL,
        nav_units           BIGINT       NOT NULL,
        open_position_count INTEGER      NOT NULL,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_san_nav_nonneg CHECK (nav_units >= 0),
        CONSTRAINT chk_san_open_count_nonneg CHECK (open_position_count >= 0)
      )
    `);

    // NAV cron idempotency: at most one row per UTC day. Cast must be IMMUTABLE
    // for a partial unique index — same posture as the yield_accrual partial
    // unique index in 1715000000000-Initial.ts.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uniq_stat_arb_nav_per_day
        ON stat_arb_nav (((as_of AT TIME ZONE 'UTC')::date))
    `);

    // NAV range scan for the dashboard.
    await queryRunner.query(`
      CREATE INDEX idx_stat_arb_nav_as_of
        ON stat_arb_nav (as_of DESC)
    `);

    // ── App role: meridian_markets_app ───────────────────────────────────────
    // SELECT,INSERT only — append-only, same as treasury_movements and
    // hedge_movements. UPDATE/DELETE intentionally absent. Asserted by
    // src/database/append-only.int-spec.ts.
    await queryRunner.query(`
      GRANT SELECT, INSERT ON stat_arb_trades TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON stat_arb_nav TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE stat_arb_trades_id_seq TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE stat_arb_nav_id_seq TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON stat_arb_trades FROM meridian_markets_app`);
    await queryRunner.query(`REVOKE ALL ON stat_arb_nav FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_stat_arb_nav_as_of`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_stat_arb_nav_per_day`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_stat_arb_trades_recent`);
    await queryRunner.query(`DROP TABLE IF EXISTS stat_arb_nav`);
    await queryRunner.query(`DROP TABLE IF EXISTS stat_arb_trades`);
  }
}
