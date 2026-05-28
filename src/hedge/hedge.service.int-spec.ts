import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { DbService } from '@database/db.service';
import { MockHedgeVenue } from './mock-hedge-venue';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { HedgeService } from './hedge.service';
import {
  describeIfDb,
  dbAvailableCached,
  newAppDataSource,
} from '../test-helpers/postgres-available';

const ONE_USDC = 1_000_000n;

// Shared config used for all tests — real-number config the service needs.
const TEST_CFG = {
  getOrThrow: () => ({
    hedge: {
      maxFundingBps: 100,
      maxFeedStalenessMs: 300_000,
      ilsSigmaBps: 94,
      positionStalenessMs: 30_000,
    },
  }),
} as unknown as ConfigService;

describeIfDb('INTEGRATION: HedgeService against real Postgres', () => {
  let ds: DataSource;
  let db: DbService;
  let venue: MockHedgeVenue;
  let svc: HedgeService;
  let dbUp = false;

  beforeAll(async () => {
    dbUp = await dbAvailableCached();
    if (!dbUp) return;
    ds = newAppDataSource();
    await ds.initialize();
    db = new DbService(ds);
  });

  afterAll(async () => {
    if (dbUp && ds) await ds.destroy();
  });

  beforeEach(() => {
    if (!dbUp) return;
    // Fresh venue per test AND a unique venueId namespace per test so DB
    // queries against hedge_movements / hedge_positions never see rows from
    // prior test runs. Same isolation pattern as treasury.service.int-spec.ts.
    venue = new MockHedgeVenue(2, 0);
    (venue as { venueId: string }).venueId =
      `mock-${Math.random().toString(36).slice(2, 10)}`;
    const breaker = new HedgeCircuitBreaker(TEST_CFG);
    svc = new HedgeService(db, venue, breaker, TEST_CFG);
  });

  it('openShort writes to hedge_movements and hedge_positions', async () => {
    if (!dbUp) return pending();
    const row = await svc.openShort(100n * ONE_USDC, 'int-open-1');
    expect(row.direction).toBe('OPEN_SHORT');
    expect(row.notionalUnits).toBe(100n * ONE_USDC);
    expect(row.positionRef).not.toBeNull();

    // Position cache should have been populated.
    const refs = await svc.listOpenPositionRefs();
    expect(refs).toContain(row.positionRef);
  });

  it('openShort idempotency: second call with same key returns the first row', async () => {
    if (!dbUp) return pending();
    const a = await svc.openShort(50n * ONE_USDC, 'int-idem-1');
    const b = await svc.openShort(50n * ONE_USDC, 'int-idem-1');
    expect(a.id).toBe(b.id);

    // Only one open position should exist.
    const refs = await svc.listOpenPositionRefs();
    const matchingRefs = refs.filter((r) => r === a.positionRef);
    expect(matchingRefs).toHaveLength(1);
  });

  it('closeShort marks position as closed and records realised PnL', async () => {
    if (!dbUp) return pending();
    const opened = await svc.openShort(200n * ONE_USDC, 'int-close-open-1');
    const positionRef = opened.positionRef as string;

    const closed = await svc.closeShort(positionRef, 'int-close-1');
    expect(closed.direction).toBe('CLOSE_SHORT');
    expect(closed.notionalUnits).toBe(-200n * ONE_USDC);
    expect(closed.pnlUnits).toBeDefined(); // mock returns 0 (no time elapsed)

    // Should no longer appear as open.
    const refs = await svc.listOpenPositionRefs();
    expect(refs).not.toContain(positionRef);
  });

  it('getTotalOpenNotional returns 0 when no positions are open', async () => {
    if (!dbUp) return pending();
    const total = await svc.getTotalOpenNotional();
    expect(total).toBe(0n);
  });

  it('getTotalOpenNotional sums multiple open positions', async () => {
    if (!dbUp) return pending();
    await svc.openShort(100n * ONE_USDC, 'int-sum-1');
    await svc.openShort(200n * ONE_USDC, 'int-sum-2');
    const total = await svc.getTotalOpenNotional();
    expect(total).toBe(300n * ONE_USDC);
  });

  it('markAll writes MARK_TO_MARKET and is idempotent for the same day', async () => {
    if (!dbUp) return pending();
    const opened = await svc.openShort(500n * ONE_USDC, 'int-mark-open-1');
    const positionRef = opened.positionRef as string;

    // First mark — should succeed.
    await svc.markAll();

    // Second mark same day — should be silently ignored (unique index 23505).
    await expect(svc.markAll()).resolves.toBeUndefined();

    // Exactly one MARK_TO_MARKET movement should exist for this position today.
    const rows = await ds.query<{ c: string }[]>(
      `SELECT COUNT(*)::text AS c
         FROM hedge_movements
        WHERE position_ref = $1 AND direction = 'MARK_TO_MARKET'`,
      [positionRef],
    );
    expect(Number(rows[0].c)).toBe(1);
  });
});

function pending(): void {
  expect(true).toBe(true);
}
