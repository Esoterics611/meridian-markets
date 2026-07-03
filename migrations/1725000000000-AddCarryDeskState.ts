import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — carry-desk persistence (PROFIT_PIVOT_II P0).
//
//   carry_book_state — a MUTABLE checkpoint cache (one row per symbol), the exact
//   regime_book_state posture: meridian_markets_app has SELECT, INSERT, UPDATE —
//   NO DELETE. A de-validated / closed pair is SOFT-closed (status='CLOSED'), keeping
//   its final P&L. The row holds the two-leg ledger as a JSONB blob
//   (FundingCarryBook.serializeState() — bigints as decimal strings) so a restart
//   RESUMES the held pair instead of paying the round-trip fee again — carry is a
//   hold-past-breakeven trade, so flatten-on-restart would destroy the economics
//   the book exists to measure.
//
//   The equity curve reuses mm_nav with desk='carry' under the '@carry' book_key
//   namespace (the desk column + index shipped with 1724000000000-AddRegimeDeskState).
//
// Money/size in 6-decimal units (BIGINT); prices in micros — repo-wide convention.

export class AddCarryDeskState1725000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE carry_book_state (
        symbol               TEXT             PRIMARY KEY,
        direction            TEXT             NOT NULL,
        gate_annualized_pct  DOUBLE PRECISION NOT NULL,
        entry_ms             BIGINT,
        status               TEXT             NOT NULL DEFAULT 'OPEN',
        state                JSONB            NOT NULL,
        created_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_cbs_status    CHECK (status IN ('OPEN','CLOSED')),
        CONSTRAINT chk_cbs_direction CHECK (direction IN ('SHORT_PERP','LONG_PERP'))
      )
    `);

    // Boot rehydration scans the OPEN books only.
    await queryRunner.query(`
      CREATE INDEX idx_carry_book_state_open
        ON carry_book_state (status) WHERE status = 'OPEN'
    `);

    // App role: SELECT, INSERT, UPDATE — mutable cache, NO DELETE (soft close via status).
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON carry_book_state TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON carry_book_state FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_carry_book_state_open`);
    await queryRunner.query(`DROP TABLE IF EXISTS carry_book_state`);
  }
}
