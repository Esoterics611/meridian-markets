import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — Phase 0 initial schema.
//
// Two tables:
//
//   treasury_movements  — APPEND-ONLY ledger of every deposit, withdraw, and
//                         yield-accrual event. Tamper-proof at the DB privilege
//                         layer: meridian_markets_app has SELECT,INSERT only.
//                         No UPDATE, no DELETE, ever. This is the legal record
//                         of every dollar that touched a yield provider.
//
//   treasury_positions  — Mutable cached view of current principal +
//                         accumulated yield per provider. Derivable from
//                         treasury_movements; kept hot to avoid recomputing
//                         a running sum on every read. Single row per provider.
//
// USDC has 6 decimals: 1 USDC = 1_000_000 units. All `*_units` columns store
// 6-decimal integer units (BIGINT). Same convention as Lira-Bridge.

export class Initial1715000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TYPE movement_direction AS ENUM (
        'DEPOSIT',
        'WITHDRAW',
        'YIELD_ACCRUAL'
      )
    `);

    // ── treasury_movements (append-only) ─────────────────────────────────────
    // running_balance_units stores the post-event balance so a single row
    // read answers "what was the principal at time T?" without a sum.
    // idempotency_key is required and UNIQUE — replay-safe.
    await queryRunner.query(`
      CREATE TABLE treasury_movements (
        id                     UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
        direction              movement_direction  NOT NULL,
        amount_usdc_units      BIGINT              NOT NULL,
        provider               TEXT                NOT NULL,
        external_ref           TEXT,
        idempotency_key        TEXT                NOT NULL,
        running_balance_units  BIGINT              NOT NULL,
        metadata               JSONB               NOT NULL DEFAULT '{}'::jsonb,
        created_at             TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_amount_positive          CHECK (amount_usdc_units > 0),
        CONSTRAINT chk_running_balance_nonneg   CHECK (running_balance_units >= 0),
        CONSTRAINT uniq_idempotency_per_provider UNIQUE (provider, idempotency_key)
      )
    `);

    // Lookup: latest movement per provider for running-balance reads.
    await queryRunner.query(`
      CREATE INDEX idx_treasury_movements_provider_created_at
        ON treasury_movements (provider, created_at DESC)
    `);

    // Yield-accrual cron idempotency: at most one accrual per (provider, UTC day).
    // TIMESTAMPTZ::date is STABLE (session-timezone-dependent); AT TIME ZONE 'UTC'
    // returns a plain TIMESTAMP whose ::date cast is IMMUTABLE — required for indexes.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uniq_yield_accrual_per_provider_per_day
        ON treasury_movements (provider, ((created_at AT TIME ZONE 'UTC')::date))
        WHERE direction = 'YIELD_ACCRUAL'
    `);

    // ── treasury_positions (mutable cache) ───────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE treasury_positions (
        provider             TEXT         PRIMARY KEY,
        principal_units      BIGINT       NOT NULL DEFAULT 0,
        yield_earned_units   BIGINT       NOT NULL DEFAULT 0,
        last_synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_principal_nonneg     CHECK (principal_units >= 0),
        CONSTRAINT chk_yield_earned_nonneg  CHECK (yield_earned_units >= 0)
      )
    `);

    // ── App role: meridian_markets_app ───────────────────────────────────────
    // SELECT,INSERT on treasury_movements (append-only).
    // SELECT,INSERT,UPDATE on treasury_positions (cache is mutable).
    // No DELETE on either. The migration role (POSTGRES_USER) keeps full
    // power — only the app role is locked down.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT FROM pg_catalog.pg_roles WHERE rolname = 'meridian_markets_app'
        ) THEN
          CREATE ROLE meridian_markets_app LOGIN PASSWORD 'meridian_markets_app';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`GRANT CONNECT ON DATABASE meridian_markets TO meridian_markets_app`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO meridian_markets_app`);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON treasury_movements TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON treasury_positions TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON treasury_movements FROM meridian_markets_app`);
    await queryRunner.query(`REVOKE ALL ON treasury_positions FROM meridian_markets_app`);

    await queryRunner.query(`DROP TABLE IF EXISTS treasury_positions`);
    await queryRunner.query(`DROP TABLE IF EXISTS treasury_movements`);
    await queryRunner.query(`DROP TYPE  IF EXISTS movement_direction`);
  }
}
