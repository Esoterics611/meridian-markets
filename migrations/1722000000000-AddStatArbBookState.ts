import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — stat-arb restart-safe books.
//
//   stat_arb_book_state — a MUTABLE checkpoint cache (one row per live stat-arb
//   book), the exact analogue of mm_book_state: meridian_markets_app has
//   SELECT, INSERT, UPDATE — NO DELETE. A removed book is SOFT-closed
//   (status='CLOSED'), so its final P&L survives forever. The row holds the
//   book's CONFIG (the pair, strategy, β, notional, capital, source — enough to
//   rebuild the strategy/feed/venue on boot) plus the evolving P&L STATE as a
//   JSONB blob (StatArbBookState — all bigints are decimal strings, JSON-safe).
//   The in-memory live book becomes a durable, restart-safe ledger; the strategy
//   resumes in its held regime so an open position is worked off, not re-opened.
//
// Money/size in 6-decimal units (BIGINT) — repo-wide convention.

export class AddStatArbBookState1722000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stat_arb_book_state (
        book_key         TEXT             PRIMARY KEY,
        symbol_a         TEXT             NOT NULL,
        symbol_b         TEXT             NOT NULL,
        source           TEXT,
        strategy_id      TEXT             NOT NULL,
        beta             DOUBLE PRECISION,
        params           JSONB,
        notional_units   BIGINT           NOT NULL,
        capital_units    BIGINT           NOT NULL,
        running          BOOLEAN          NOT NULL DEFAULT TRUE,
        status           TEXT             NOT NULL DEFAULT 'OPEN',
        state            JSONB            NOT NULL,
        created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_sabs_status       CHECK (status IN ('OPEN','CLOSED')),
        CONSTRAINT chk_sabs_notional_pos CHECK (notional_units > 0),
        CONSTRAINT chk_sabs_capital_pos  CHECK (capital_units > 0)
      )
    `);

    // Boot rehydration scans the OPEN books only.
    await queryRunner.query(`
      CREATE INDEX idx_stat_arb_book_state_open
        ON stat_arb_book_state (status) WHERE status = 'OPEN'
    `);

    // App role: SELECT, INSERT, UPDATE — mutable cache, NO DELETE (soft close via
    // status). Same posture as mm_book_state / treasury_positions. TEXT PK ⇒ no
    // sequence grant.
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON stat_arb_book_state TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON stat_arb_book_state FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_stat_arb_book_state_open`);
    await queryRunner.query(`DROP TABLE IF EXISTS stat_arb_book_state`);
  }
}
