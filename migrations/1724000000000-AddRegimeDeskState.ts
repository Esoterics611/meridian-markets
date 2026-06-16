import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — "take sides" Regime Desk persistence (Playbook II P6).
//
//   regime_book_state — a MUTABLE checkpoint cache (one row per symbol), the same
//   posture as mm_book_state / treasury_positions: meridian_markets_app has
//   SELECT, INSERT, UPDATE — NO DELETE. A de-validated / removed book is SOFT-closed
//   (status='CLOSED'), keeping its final P&L. The row holds the position's entry
//   context (entry mark + entry time) + the evolving ledger STATE as a JSONB blob
//   (RegimeDirectionalBook.serializeState() — bigints as decimal strings, JSON-safe),
//   so the book resumes its carried position on boot instead of re-opening from flat.
//
//   mm_nav.desk — a new APPEND-ONLY tag so the regime desk's equity curve is filterable
//   from the MM desk's. Existing MM writes default to 'mm' (purely additive — the MM
//   repository is untouched). The regime desk writes desk='regime' under a '@regime'
//   book_key namespace, so the two desks' curves never collide in the one shared table.
//
// Money/size in 6-decimal units (BIGINT); prices in micros — repo-wide convention.

export class AddRegimeDeskState1724000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE regime_book_state (
        symbol            TEXT             PRIMARY KEY,
        signal            TEXT             NOT NULL,
        ic                DOUBLE PRECISION NOT NULL,
        entry_mid_micros  BIGINT,
        entry_ms          BIGINT,
        status            TEXT             NOT NULL DEFAULT 'OPEN',
        state             JSONB            NOT NULL,
        created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_rbs_status CHECK (status IN ('OPEN','CLOSED'))
      )
    `);

    // Boot rehydration scans the OPEN books only.
    await queryRunner.query(`
      CREATE INDEX idx_regime_book_state_open
        ON regime_book_state (status) WHERE status = 'OPEN'
    `);

    // App role: SELECT, INSERT, UPDATE — mutable cache, NO DELETE (soft close via status).
    // Same posture as mm_book_state. TEXT PK ⇒ no sequence grant.
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON regime_book_state TO meridian_markets_app
    `);

    // mm_nav desk tag — additive, defaults to 'mm' so every existing MM write/read is
    // unchanged. The table-level GRANT already covers the new column (no re-grant needed).
    await queryRunner.query(`
      ALTER TABLE mm_nav ADD COLUMN desk TEXT NOT NULL DEFAULT 'mm'
    `);
    // Regime desk curve range scan (desk + book_key + time).
    await queryRunner.query(`
      CREATE INDEX idx_mm_nav_desk_book_as_of
        ON mm_nav (desk, book_key, as_of DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_mm_nav_desk_book_as_of`);
    await queryRunner.query(`ALTER TABLE mm_nav DROP COLUMN IF EXISTS desk`);
    await queryRunner.query(`REVOKE ALL ON regime_book_state FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_regime_book_state_open`);
    await queryRunner.query(`DROP TABLE IF EXISTS regime_book_state`);
  }
}
