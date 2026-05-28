import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — Phase 1 FX hedge schema.
//
// Two tables, same posture as Phase 0 (treasury_movements / treasury_positions):
//
//   hedge_movements  — APPEND-ONLY ledger of every hedge open, close, mark, and
//                      funding event. meridian_markets_app has SELECT,INSERT only.
//                      No UPDATE, no DELETE, ever.
//
//   hedge_positions  — Mutable cached view of current open/closed positions per
//                      venue. Derivable from hedge_movements if ever lost.
//
// Cron idempotency on MARK_TO_MARKET: at most one mark per (venue, position_ref,
// day). Equivalent to the YIELD_ACCRUAL partial index in Phase 0.
//
// USDC notional is in 6-decimal integer units. Prices are in micros (1e6 of
// ILS-per-USD). Same conventions as treasury_movements and MockHedgeVenue.

export class AddHedgeTables1716000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // ── hedge_movements (append-only) ─────────────────────────────────────────
    // notional_units is signed:
    //   OPEN_SHORT:           > 0  (amount of notional opened)
    //   CLOSE_SHORT:          < 0  (amount of notional closed, same magnitude as open)
    //   MARK_TO_MARKET:       any  (snapshot of current position notional)
    //   FUNDING_ACCRUAL:      any  (snapshot of current position notional)
    await queryRunner.query(`
      CREATE TABLE hedge_movements (
        id               BIGSERIAL    PRIMARY KEY,
        venue            TEXT         NOT NULL,
        direction        TEXT         NOT NULL,
        notional_units   BIGINT       NOT NULL,
        pnl_units        BIGINT,
        funding_units    BIGINT,
        position_ref     TEXT,
        external_ref     TEXT         NOT NULL,
        idempotency_key  TEXT         NOT NULL,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_hm_direction CHECK (
          direction IN ('OPEN_SHORT','CLOSE_SHORT','FUNDING_ACCRUAL','MARK_TO_MARKET')
        ),
        CONSTRAINT chk_hm_notional CHECK (
          (direction = 'OPEN_SHORT'  AND notional_units > 0) OR
          (direction = 'CLOSE_SHORT' AND notional_units < 0) OR
          (direction IN ('FUNDING_ACCRUAL','MARK_TO_MARKET'))
        ),
        CONSTRAINT uniq_hm_idempotency UNIQUE (venue, idempotency_key)
      )
    `);

    // Lookup: all movements for a given position.
    await queryRunner.query(`
      CREATE INDEX idx_hedge_movements_position_ref
        ON hedge_movements (venue, position_ref, created_at DESC)
        WHERE position_ref IS NOT NULL
    `);

    // Mark-to-market cron idempotency: at most one MARK_TO_MARKET per position per day.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uniq_mark_per_position_per_day
        ON hedge_movements (venue, position_ref, ((created_at AT TIME ZONE 'UTC')::date))
        WHERE direction = 'MARK_TO_MARKET'
    `);

    // Funding cron idempotency: at most one FUNDING_ACCRUAL per position per day.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uniq_funding_per_position_per_day
        ON hedge_movements (venue, position_ref, ((created_at AT TIME ZONE 'UTC')::date))
        WHERE direction = 'FUNDING_ACCRUAL'
    `);

    // ── hedge_positions (mutable cache) ──────────────────────────────────────
    // Single row per position_ref. closed_at IS NULL for open positions.
    await queryRunner.query(`
      CREATE TABLE hedge_positions (
        position_ref          TEXT         PRIMARY KEY,
        venue                 TEXT         NOT NULL,
        notional_units        BIGINT       NOT NULL,
        entry_price_micros    BIGINT       NOT NULL,
        opened_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        closed_at             TIMESTAMPTZ,
        last_mark_micros      BIGINT,
        last_pnl_units        BIGINT,
        last_funding_units    BIGINT,
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // Open-position lookup for the hedge monitor cron.
    await queryRunner.query(`
      CREATE INDEX idx_hedge_positions_open
        ON hedge_positions (venue, opened_at ASC)
        WHERE closed_at IS NULL
    `);

    // ── App role: meridian_markets_app ───────────────────────────────────────
    // SELECT,INSERT on hedge_movements (append-only, same as treasury_movements).
    // SELECT,INSERT,UPDATE on hedge_positions (cache is mutable, same as
    //   treasury_positions). No DELETE on either.
    await queryRunner.query(`
      GRANT SELECT, INSERT ON hedge_movements TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON hedge_positions TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON hedge_movements FROM meridian_markets_app`);
    await queryRunner.query(`REVOKE ALL ON hedge_positions FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_hedge_positions_open`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_funding_per_position_per_day`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_mark_per_position_per_day`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_hedge_movements_position_ref`);
    await queryRunner.query(`DROP TABLE IF EXISTS hedge_positions`);
    await queryRunner.query(`DROP TABLE IF EXISTS hedge_movements`);
  }
}
