import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — market-making restart-safe books.
//
//   mm_book_state — a MUTABLE checkpoint cache (one row per live MM book), the
//   same posture as treasury_positions (Phase 0): meridian_markets_app has
//   SELECT, INSERT, UPDATE — NO DELETE. A removed book is SOFT-closed
//   (status='CLOSED'), so its final P&L survives forever (a real company keeps
//   its closed books). The row holds the book's CONFIG (enough to rebuild the
//   quoter / feed / risk gate on boot) plus the evolving P&L STATE as a JSONB
//   blob (MmBookState — all bigints are decimal strings, JSON-safe). The book is
//   exactly reconstructable from this row, so the in-memory live book becomes a
//   durable, restart-safe ledger.
//
// Money/size in 6-decimal units (BIGINT); prices in micros — repo-wide convention.

export class AddMmBookState1720000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mm_book_state (
        book_key                 TEXT             PRIMARY KEY,
        symbol                   TEXT             NOT NULL,
        source                   TEXT,
        strategy_id              TEXT             NOT NULL,
        params                   JSONB,
        gamma                    DOUBLE PRECISION NOT NULL,
        kappa                    DOUBLE PRECISION NOT NULL,
        horizon_bars             INTEGER          NOT NULL,
        vol_window_bars          INTEGER          NOT NULL,
        vol_floor                DOUBLE PRECISION NOT NULL,
        maker_fee_bps            DOUBLE PRECISION NOT NULL,
        funding_rate_per_hour    DOUBLE PRECISION NOT NULL DEFAULT 0,
        quote_size_units         BIGINT           NOT NULL,
        capital_units            BIGINT           NOT NULL,
        running                  BOOLEAN          NOT NULL DEFAULT TRUE,
        status                   TEXT             NOT NULL DEFAULT 'OPEN',
        state                    JSONB            NOT NULL,
        created_at               TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_mbs_status     CHECK (status IN ('OPEN','CLOSED')),
        CONSTRAINT chk_mbs_quote_pos  CHECK (quote_size_units > 0),
        CONSTRAINT chk_mbs_capital_pos CHECK (capital_units > 0)
      )
    `);

    // Boot rehydration scans the OPEN books only.
    await queryRunner.query(`
      CREATE INDEX idx_mm_book_state_open
        ON mm_book_state (status) WHERE status = 'OPEN'
    `);

    // App role: SELECT, INSERT, UPDATE — mutable cache, NO DELETE (soft close via
    // status). Same posture as treasury_positions. TEXT PK ⇒ no sequence grant.
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON mm_book_state TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON mm_book_state FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_mm_book_state_open`);
    await queryRunner.query(`DROP TABLE IF EXISTS mm_book_state`);
  }
}
