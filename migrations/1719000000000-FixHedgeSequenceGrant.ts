import { MigrationInterface, QueryRunner } from 'typeorm';

// Meridian Markets — micro-fix for Session 4's hedge_movements BIGSERIAL.
//
// Migration 1716 created `hedge_movements` with a BIGSERIAL `id` column, which
// implicitly creates the `hedge_movements_id_seq` sequence. The original
// migration GRANTed SELECT, INSERT on the table — but did NOT grant USAGE on
// the sequence, so meridian_markets_app could not actually INSERT (Postgres
// requires USAGE on the sequence to call nextval()).
//
// Manifested as five failing integration specs:
//   src/hedge/hedge.service.int-spec.ts — permission denied for sequence
//   hedge_movements_id_seq
//
// Later migrations 1717 (stat_arb_trades) and 1718 (data_gaps) include
// `GRANT USAGE, SELECT ON SEQUENCE …_id_seq TO meridian_markets_app` from
// the start. This migration backfills the same posture for hedge_movements.
//
// The append-only invariant is unchanged — USAGE on a sequence is required
// for INSERT (nextval), not for UPDATE/DELETE on the parent table. The
// existing append-only spec at src/database/append-only.int-spec.ts
// continues to assert SELECT,INSERT only on the table.

export class FixHedgeSequenceGrant1719000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE hedge_movements_id_seq TO meridian_markets_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE USAGE, SELECT ON SEQUENCE hedge_movements_id_seq FROM meridian_markets_app
    `);
  }
}
