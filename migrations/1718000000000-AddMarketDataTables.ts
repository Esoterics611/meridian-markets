import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — Phase 3 market-data persistence.
//
// Three tables:
//
//   market_bars   — APPEND-ONLY OHLCV ingest. (venue, symbol, ts) UNIQUE so
//                   re-ingest is idempotent. Promoted to a TimescaleDB
//                   hypertable when the extension is available; otherwise
//                   served by plain Postgres + a btree index. The repo code
//                   paths are identical in both shapes.
//
//   funding_rates — APPEND-ONLY perp funding snapshots. Same hypertable
//                   posture as market_bars.
//
//   data_gaps    — APPEND-ONLY ledger of detected ingest gaps (one row per
//                   detected gap). Drives the Risk-view Data Quality card.
//
// All three grant SELECT,INSERT only to meridian_markets_app — same posture
// as treasury_movements / hedge_movements / stat_arb_trades. Asserted by
// src/database/append-only.int-spec.ts.

export class AddMarketDataTables1718000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // TimescaleDB is the production target but isn't bundled with stock
    // Postgres. Try to enable it; if the shared library isn't installed we
    // fall through cleanly to plain tables + btree indexes. The application
    // code does not care which path is live — repo queries are identical.
    let timescaleAvailable = false;
    try {
      await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
      timescaleAvailable = true;
    } catch {
      timescaleAvailable = false;
    }

    // ── market_bars ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE market_bars (
        venue          TEXT         NOT NULL,
        symbol         TEXT         NOT NULL,
        ts             TIMESTAMPTZ  NOT NULL,
        open_micros    BIGINT       NOT NULL,
        high_micros    BIGINT       NOT NULL,
        low_micros     BIGINT       NOT NULL,
        close_micros   BIGINT       NOT NULL,
        volume_micros  BIGINT       NOT NULL,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_mb_prices_nonneg CHECK (
          open_micros >= 0 AND high_micros >= 0 AND low_micros >= 0 AND close_micros >= 0
        ),
        CONSTRAINT chk_mb_hl CHECK (high_micros >= low_micros),
        CONSTRAINT uniq_mb_bar UNIQUE (venue, symbol, ts)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mb_symbol_ts ON market_bars (venue, symbol, ts DESC)
    `);

    // ── funding_rates ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE funding_rates (
        venue       TEXT         NOT NULL,
        symbol      TEXT         NOT NULL,
        ts          TIMESTAMPTZ  NOT NULL,
        rate_micros BIGINT       NOT NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT uniq_fr_rate UNIQUE (venue, symbol, ts)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_fr_symbol_ts ON funding_rates (venue, symbol, ts DESC)
    `);

    // ── data_gaps ──────────────────────────────────────────────────────────
    // Append-only — each detected gap is one row. The detector dedupes via
    // a per-(venue,symbol,gap_start) UNIQUE so re-running ingest never
    // double-writes the same gap.
    await queryRunner.query(`
      CREATE TABLE data_gaps (
        id              BIGSERIAL    PRIMARY KEY,
        venue           TEXT         NOT NULL,
        symbol          TEXT         NOT NULL,
        gap_start       TIMESTAMPTZ  NOT NULL,
        gap_end         TIMESTAMPTZ  NOT NULL,
        missing_bars    INTEGER      NOT NULL,
        detected_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_dg_missing_pos CHECK (missing_bars > 0),
        CONSTRAINT chk_dg_range CHECK (gap_end > gap_start),
        CONSTRAINT uniq_dg_gap UNIQUE (venue, symbol, gap_start)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_dg_recent ON data_gaps (venue, symbol, detected_at DESC)
    `);

    // ── TimescaleDB promotion (best-effort) ────────────────────────────────
    if (timescaleAvailable) {
      // Convert to hypertables. `if_not_exists` keeps the migration
      // re-runnable. We don't bother with continuous aggregates yet —
      // queue for Session 12 (research) once we know which rollups matter.
      try {
        await queryRunner.query(
          `SELECT create_hypertable('market_bars', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`,
        );
        await queryRunner.query(
          `SELECT create_hypertable('funding_rates', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`,
        );
      } catch {
        // Extension was present but hypertable creation failed (e.g. an
        // existing constraint conflicts). Leave the tables as plain
        // Postgres — code path is identical.
      }
    }

    // ── App role grants ────────────────────────────────────────────────────
    await queryRunner.query(`
      GRANT SELECT, INSERT ON market_bars TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON funding_rates TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON data_gaps TO meridian_markets_app
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE data_gaps_id_seq TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON data_gaps FROM meridian_markets_app`);
    await queryRunner.query(`REVOKE ALL ON funding_rates FROM meridian_markets_app`);
    await queryRunner.query(`REVOKE ALL ON market_bars FROM meridian_markets_app`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_dg_recent`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_fr_symbol_ts`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_mb_symbol_ts`);
    await queryRunner.query(`DROP TABLE IF EXISTS data_gaps`);
    await queryRunner.query(`DROP TABLE IF EXISTS funding_rates`);
    await queryRunner.query(`DROP TABLE IF EXISTS market_bars`);
  }
}
