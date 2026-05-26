import { BadRequestException } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService, MovementRow, PositionSnapshot } from './treasury.service';
import { InsufficientPrincipalError, InvalidAmountError } from './treasury.errors';

function fakeMovement(over: Partial<MovementRow> = {}): MovementRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    direction: 'DEPOSIT',
    amountUnits: 1000n,
    provider: 'mock',
    externalRef: 'mock-dep-k1',
    runningBalanceUnits: 1000n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

function fakeService(over: Partial<TreasuryService> = {}): TreasuryService {
  const base: Partial<TreasuryService> = {
    deposit: jest.fn(async () => fakeMovement()),
    withdraw: jest.fn(async () => fakeMovement({ direction: 'WITHDRAW' })),
    getPosition: jest.fn(async (): Promise<PositionSnapshot> => ({
      provider: 'mock',
      principalUnits: 1000n,
      yieldEarnedUnits: 0n,
      lastSyncedAt: new Date('2026-01-01T00:00:00.000Z'),
    })),
  };
  return { ...base, ...over } as TreasuryService;
}

describe('TreasuryController', () => {
  it('serialises a deposit response with BigInts as strings', async () => {
    const c = new TreasuryController(fakeService());
    const res = await c.deposit({ amount_usdc_units: '1000', idempotency_key: 'k1' });
    expect(res.amount_usdc_units).toBe('1000');
    expect(res.direction).toBe('DEPOSIT');
    expect(res.running_balance_units).toBe('1000');
  });

  it('rejects when amount_usdc_units is missing', async () => {
    const c = new TreasuryController(fakeService());
    await expect(
      c.deposit({ idempotency_key: 'k1' } as unknown as { idempotency_key: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when idempotency_key is missing', async () => {
    const c = new TreasuryController(fakeService());
    await expect(
      c.deposit({ amount_usdc_units: '1000' } as unknown as { amount_usdc_units: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when amount_usdc_units is not a valid integer string', async () => {
    const c = new TreasuryController(fakeService());
    await expect(
      c.deposit({ amount_usdc_units: 'not-a-number', idempotency_key: 'k1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects amounts <= 0', async () => {
    const c = new TreasuryController(fakeService());
    await expect(
      c.deposit({ amount_usdc_units: '0', idempotency_key: 'k1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      c.deposit({ amount_usdc_units: '-5', idempotency_key: 'k1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('translates InsufficientPrincipalError to BadRequest', async () => {
    const svc = fakeService({
      withdraw: jest.fn(async () => {
        throw new InsufficientPrincipalError('mock', 200n, 100n);
      }),
    } as Partial<TreasuryService>);
    const c = new TreasuryController(svc);
    await expect(
      c.withdraw({ amount_usdc_units: '200', idempotency_key: 'k1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('translates InvalidAmountError to BadRequest', async () => {
    const svc = fakeService({
      deposit: jest.fn(async () => {
        throw new InvalidAmountError(0n);
      }),
    } as Partial<TreasuryService>);
    const c = new TreasuryController(svc);
    await expect(
      c.deposit({ amount_usdc_units: '1', idempotency_key: 'k1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exposes /position with stringified bigints', async () => {
    const c = new TreasuryController(fakeService());
    const res = await c.position();
    expect(res).toEqual({
      provider: 'mock',
      principal_units: '1000',
      yield_earned_units: '0',
      last_synced_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('exposes /yield-earned', async () => {
    const c = new TreasuryController(fakeService());
    const res = await c.yieldEarned();
    expect(res).toEqual({ provider: 'mock', yield_earned_units: '0' });
  });
});
