import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — durable MM NAV / equity-curve history (Telemetry P3).
//
//   mm_nav — an APPEND-ONLY per-interval time series of the market-making desk's
//   NAV + equity, the durable research deliverable (a multi-day track record that
//   survives restart). Written by MmNavCron each interval (default 60s) when
//   MM_PERSIST is on; mirrors the stat_arb_nav posture (1717000000000) but is a
//   *per-interval* series, not a per-day snapshot — so there is deliberately NO
//   per-day unique index. Every tick is a row.
//
//   One table carries both granularities: book_key = '' is the DESK AGGREGATE row
//   (its equity_units equals the live `meridian_desk_nav_units` gauge to the unit —
//   the §8 acceptance criterion), and book_key = '<SYMBOL>' is a per-book equity
//   row. The cron derives every value from MmPortfolioTrader.snapshot() at write
//   time (DC-3: read the ledger, never a parallel accounting path), so the table is
//   the durable record of what the in-memory books already reported.
//
//   meridian_markets_app has SELECT,INSERT only — append-only at the privilege
//   layer, same oracle as treasury_movements / stat_arb_nav (asserted by
//   src/database/append-only.int-spec.ts). No UPDATE, no DELETE, ever.
//
// Money/P&L in 6-decimal USDC units (BIGINT); inventory in 6-decimal asset units;
// drawdown a percent (DOUBLE PRECISION) — the repo-wide conventions.

export class AddMmNav1721000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mm_nav (
        id                    BIGSERIAL        PRIMARY KEY,
        as_of                 TIMESTAMPTZ      NOT NULL,
        book_key              TEXT             NOT NULL DEFAULT '',
        equity_units          BIGINT           NOT NULL,
        net_pnl_units         BIGINT           NOT NULL,
        realised_pnl_units    BIGINT           NOT NULL,
        unrealised_pnl_units  BIGINT           NOT NULL,
        fees_units            BIGINT           NOT NULL,
        funding_units         BIGINT           NOT NULL,
        inventory_units       BIGINT           NOT NULL,
        max_drawdown_pct      DOUBLE PRECISION NOT NULL,
        created_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_mm_nav_drawdown_nonneg CHECK (max_drawdown_pct >= 0)
      )
    `);

    // Desk equity-curve range scan (book_key = '' rows over a time window).
    await queryRunner.query(`
      CREATE INDEX idx_mm_nav_as_of
        ON mm_nav (as_of DESC)
    `);

    // Per-book curve: filter by book_key, scan by time. Covers the desk rows too
    // (book_key = ''), so both endpoints (?book=SYMBOL and the desk default) use it.
    await queryRunner.query(`
      CREATE INDEX idx_mm_nav_book_as_of
        ON mm_nav (book_key, as_of DESC)
    `);

    // App role: SELECT,INSERT only — append-only, same posture as stat_arb_nav.
    // UPDATE/DELETE intentionally absent. Asserted by append-only.int-spec.ts.
    await queryRunner.query(`
      GRANT SELECT, INSERT ON mm_nav TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE mm_nav_id_seq TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON mm_nav FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_mm_nav_book_as_of`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_mm_nav_as_of`);
    await queryRunner.query(`DROP TABLE IF EXISTS mm_nav`);
  }
}
