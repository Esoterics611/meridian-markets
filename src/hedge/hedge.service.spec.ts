import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { DbService } from '@database/db.service';
import { MockHedgeVenue } from './mock-hedge-venue';
import { HedgeVenueUnhealthyError, VenueHealth } from './hedge-venue.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { HedgeService, HedgeMovementRow } from './hedge.service';
import { InvalidHedgeAmountError } from './hedge.errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ONE_USDC = 1_000_000n;

function makeFakeCfg(positionStalenessMs = 30_000): ConfigService {
  return {
    getOrThrow: () => ({
      hedge: { positionStalenessMs },
    }),
  } as unknown as ConfigService;
}

function makeFakeBreaker(throws = false): HedgeCircuitBreaker {
  return {
    checkVenueHealth: jest.fn(() => {
      if (throws) throw new HedgeVenueUnhealthyError('test');
    }),
    checkFeedStaleness: jest.fn(),
    maxNotional: jest.fn((m: bigint) => m),
  } as unknown as HedgeCircuitBreaker;
}

// A stubbed EntityManager that records queries and returns canned results.
function makeEm(
  overrides: Partial<Record<string, unknown>> = {},
): { em: EntityManager; queryMock: jest.Mock } {
  let callCount = 0;
  const queryMock = jest.fn().mockImplementation((sql: string) => {
    // listOpenPositionRefs — must be checked BEFORE the generic hedge_positions catch-all.
    if (sql.includes('closed_at IS NULL') && sql.includes('ORDER BY opened_at')) {
      return Promise.resolve([{ position_ref: 'mock-pos-1' }]);
    }
    // findMovement SELECT (idempotency check).
    if (sql.includes('idempotency_key') && sql.includes('SELECT')) {
      callCount++;
      return Promise.resolve([]);
    }
    // INSERT INTO hedge_movements
    if (sql.includes('INSERT INTO hedge_movements')) {
      return Promise.resolve([
        {
          id: '1',
          venue: 'mock',
          direction: 'OPEN_SHORT',
          notional_units: '1000000',
          pnl_units: null,
          funding_units: null,
          position_ref: 'mock-pos-1',
          external_ref: 'mock-pos-1',
          idempotency_key: overrides['ikey'] ?? 'key1',
          created_at: new Date(),
        },
      ]);
    }
    // getTotalOpenNotional
    if (sql.includes('SUM(notional_units)')) return Promise.resolve([{ total: '0' }]);
    // Generic hedge_positions catch-all (INSERT INTO / UPDATE / SELECT for closeShort).
    if (sql.includes('hedge_positions')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  return { em: { query: queryMock } as unknown as EntityManager, queryMock };
}

function makeDb(em: EntityManager): DbService {
  return {
    runInSerializableTransaction: jest.fn(async (fn: (em: EntityManager) => Promise<unknown>) =>
      fn(em),
    ),
  } as unknown as DbService;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HedgeService (unit)', () => {
  let venue: MockHedgeVenue;
  let breaker: HedgeCircuitBreaker;

  beforeEach(() => {
    venue = new MockHedgeVenue(2, 0);
    breaker = makeFakeBreaker();
  });

  it('throws InvalidHedgeAmountError for zero notional', async () => {
    const { em } = makeEm();
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    await expect(svc.openShort(0n, 'k1')).rejects.toBeInstanceOf(InvalidHedgeAmountError);
  });

  it('throws InvalidHedgeAmountError for negative notional', async () => {
    const { em } = makeEm();
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    await expect(svc.openShort(-1n, 'k1')).rejects.toBeInstanceOf(InvalidHedgeAmountError);
  });

  it('checks the circuit breaker before calling the venue', async () => {
    const throwingBreaker = makeFakeBreaker(/* throws= */ true);
    const { em } = makeEm();
    const svc = new HedgeService(makeDb(em), venue, throwingBreaker, makeFakeCfg());
    await expect(svc.openShort(ONE_USDC, 'k1')).rejects.toBeInstanceOf(HedgeVenueUnhealthyError);
    // circuit breaker should have been called
    expect(throwingBreaker.checkVenueHealth).toHaveBeenCalledTimes(1);
  });

  it('openShort calls venue and writes to the DB when the circuit breaker clears', async () => {
    const { em, queryMock } = makeEm();
    const db = makeDb(em);
    const svc = new HedgeService(db, venue, breaker, makeFakeCfg());
    const row = await svc.openShort(100n * ONE_USDC, 'k1');
    expect(row.direction).toBe('OPEN_SHORT');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO hedge_movements'),
      expect.any(Array),
    );
  });

  it('openShort returns the existing row on idempotency replay', async () => {
    // Simulate the DB returning an existing movement on the findMovement query.
    const existingRow: Partial<HedgeMovementRow> = {
      id: '99',
      venue: 'mock',
      direction: 'OPEN_SHORT',
      notionalUnits: 100n * ONE_USDC,
      positionRef: 'mock-pos-99',
    };
    const { em } = makeEm();
    (em.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('idempotency_key') && sql.includes('SELECT')) {
        return Promise.resolve([
          {
            id: '99',
            venue: 'mock',
            direction: 'OPEN_SHORT',
            notional_units: String(existingRow.notionalUnits),
            pnl_units: null,
            funding_units: null,
            position_ref: 'mock-pos-99',
            external_ref: 'mock-pos-99',
            idempotency_key: 'replay-key',
            created_at: new Date(),
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    const row = await svc.openShort(100n * ONE_USDC, 'replay-key');
    expect(row.id).toBe('99');
  });

  it('getTotalOpenNotional returns 0 when the DB reports no open positions', async () => {
    const { em } = makeEm();
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    const total = await svc.getTotalOpenNotional();
    expect(total).toBe(0n);
  });

  it('listOpenPositionRefs returns position_ref values from the DB', async () => {
    const { em } = makeEm();
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    const refs = await svc.listOpenPositionRefs();
    expect(refs).toEqual(['mock-pos-1']);
  });

  it('markAll calls fetchPosition for each open position ref', async () => {
    const { em } = makeEm();
    // Make fetchPosition return a valid HedgePosition
    const fetchPosition = jest.spyOn(venue, 'fetchPosition').mockResolvedValue({
      positionRef: 'mock-pos-1',
      notionalUnits: 100n * ONE_USDC,
      entryPriceMicros: 1_000_000n,
      markPriceMicros: 1_002_000n,
      unrealizedPnlUnits: 200_000n,
      fundingPaidUnits: 1_000n,
      asOf: new Date(),
    });
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    await svc.markAll();
    expect(fetchPosition).toHaveBeenCalledWith('mock-pos-1');
  });

  it('markAll continues when a single position mark fails', async () => {
    const { em } = makeEm();
    jest.spyOn(venue, 'fetchPosition').mockRejectedValue(new Error('venue timeout'));
    const svc = new HedgeService(makeDb(em), venue, breaker, makeFakeCfg());
    // Should not throw despite the fetchPosition failure.
    await expect(svc.markAll()).resolves.toBeUndefined();
  });
});
