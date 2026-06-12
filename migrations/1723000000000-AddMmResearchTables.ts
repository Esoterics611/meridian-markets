import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — F0 research persistence (MASTER PLAN II, Journal #58).
//
// Four append-only tables that make a FINISHED MM run fully auditable from SQL —
// before this, per-fill markouts, hedge-leg P&L, hedge quality, and the desk
// decision tape were in-memory only (gone at shutdown, DR-2), so the leak table
// reported n/a and the κ-leads-markout regression (F4) had no data.
//
//   mm_fill_markout — one row per fill × forward horizon (1s/5s/60s…), with the
//     fill context the F4 calibration needs: signed markout bps, notional, the
//     signed aggressor-flow imbalance AT the fill (κ regression input), VPIN, σ,
//     the inventory BEFORE the fill (for the A = sign(q)·sign(flow) alignment
//     quadrant), and the FIFO queue depth ahead at the fill.
//   mm_hedge_nav — per-interval, per-hedge-leg P&L written by MmNavCron (units
//     held, mark, mtm/funding/fees) — the true hedge-leg read the leak table
//     previously had to IMPLY as desk-net − books-sum.
//   mm_hedge_quality — hourly + shutdown snapshot of the hedge-quality KPI per
//     book (betaLive/R²/basisShare vs the configured β) — run55's hedge-quality
//     audit was impossible because this lived only in the live snapshot.
//   mm_desk_event — the durable desk decision tape (fills, GUARDRAIL/REGIME
//     verdicts, hedge orders, lifecycle), persisted from the same DeskEventLog
//     ring buffer the UI reads (PART V observability requirement #8).
//
// All tables: meridian_markets_app gets SELECT,INSERT only (append-only at the
// privilege layer, same oracle as mm_nav). Money in 6-dec USDC units unless a
// column is explicitly *_usd DOUBLE (hedge legs follow the controller's USD
// accounting); asset quantities in 6-dec asset units.

export class AddMmResearchTables1723000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mm_fill_markout (
        id               BIGSERIAL        PRIMARY KEY,
        ts               TIMESTAMPTZ      NOT NULL,
        book_key         TEXT             NOT NULL,
        source           TEXT             NOT NULL DEFAULT '',
        side             TEXT             NOT NULL CHECK (side IN ('BUY','SELL')),
        price_micros     BIGINT           NOT NULL,
        size_units       BIGINT           NOT NULL,
        notional_units   BIGINT           NOT NULL,
        fair_mid_micros  BIGINT           NOT NULL,
        horizon_ms       INTEGER          NOT NULL,
        markout_bps      DOUBLE PRECISION NOT NULL,
        flow             DOUBLE PRECISION,
        vpin             DOUBLE PRECISION,
        sigma            DOUBLE PRECISION,
        inventory_units_before BIGINT     NOT NULL DEFAULT 0,
        queue_ahead_units BIGINT,
        created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_fill_markout_book_ts ON mm_fill_markout (book_key, ts)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_fill_markout_ts ON mm_fill_markout (ts)
    `);

    await queryRunner.query(`
      CREATE TABLE mm_hedge_nav (
        id               BIGSERIAL        PRIMARY KEY,
        as_of            TIMESTAMPTZ      NOT NULL,
        underlying       TEXT             NOT NULL,
        units            BIGINT           NOT NULL,
        mark_micros      BIGINT           NOT NULL,
        notional_usd     DOUBLE PRECISION NOT NULL,
        net_delta_usd    DOUBLE PRECISION NOT NULL,
        residual_usd     DOUBLE PRECISION NOT NULL,
        pnl_usd          DOUBLE PRECISION NOT NULL,
        funding_usd      DOUBLE PRECISION NOT NULL,
        fees_usd         DOUBLE PRECISION NOT NULL,
        created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_hedge_nav_as_of ON mm_hedge_nav (as_of)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_hedge_nav_underlying_as_of ON mm_hedge_nav (underlying, as_of)
    `);

    await queryRunner.query(`
      CREATE TABLE mm_hedge_quality (
        id               BIGSERIAL        PRIMARY KEY,
        as_of            TIMESTAMPTZ      NOT NULL,
        book_key         TEXT             NOT NULL,
        underlying       TEXT             NOT NULL,
        beta_cfg         DOUBLE PRECISION NOT NULL,
        beta_live        DOUBLE PRECISION,
        r2               DOUBLE PRECISION,
        basis_share      DOUBLE PRECISION,
        pnl_vol_usd_hr   DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_hedge_quality_as_of ON mm_hedge_quality (as_of)
    `);

    await queryRunner.query(`
      CREATE TABLE mm_desk_event (
        id               BIGSERIAL        PRIMARY KEY,
        seq              BIGINT           NOT NULL,
        ts               TIMESTAMPTZ      NOT NULL,
        desk             TEXT             NOT NULL,
        kind             TEXT             NOT NULL,
        book_key         TEXT             NOT NULL DEFAULT '',
        source           TEXT             NOT NULL DEFAULT '',
        message          TEXT             NOT NULL,
        payload          JSONB,
        created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_desk_event_ts ON mm_desk_event (ts)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_desk_event_book_ts ON mm_desk_event (book_key, ts)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mm_desk_event_kind_ts ON mm_desk_event (kind, ts)
    `);

    for (const t of ['mm_fill_markout', 'mm_hedge_nav', 'mm_hedge_quality', 'mm_desk_event']) {
      await queryRunner.query(`GRANT SELECT, INSERT ON ${t} TO meridian_markets_app`);
      await queryRunner.query(`GRANT USAGE, SELECT ON SEQUENCE ${t}_id_seq TO meridian_markets_app`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of ['mm_desk_event', 'mm_hedge_quality', 'mm_hedge_nav', 'mm_fill_markout']) {
      await queryRunner.query(`REVOKE ALL ON ${t} FROM meridian_markets_app`);
      await queryRunner.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
