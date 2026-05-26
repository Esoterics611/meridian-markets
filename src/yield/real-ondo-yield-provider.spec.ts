import { RealOndoYieldProvider } from './real-ondo-yield-provider';
import { YieldProviderNotConfiguredError } from './yield-provider.interface';

describe('RealOndoYieldProvider (dormant in Phase 0)', () => {
  const provider = new RealOndoYieldProvider();

  it('exposes a stable providerId', () => {
    expect(provider.providerId).toBe('ondo-usdy');
  });

  it('throws YieldProviderNotConfiguredError on deposit', async () => {
    await expect(
      provider.deposit({ amountUnits: 1n, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(YieldProviderNotConfiguredError);
  });

  it('throws YieldProviderNotConfiguredError on withdraw', async () => {
    await expect(
      provider.withdraw({ amountUnits: 1n, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(YieldProviderNotConfiguredError);
  });

  it('throws YieldProviderNotConfiguredError on fetchPosition', async () => {
    await expect(provider.fetchPosition()).rejects.toBeInstanceOf(
      YieldProviderNotConfiguredError,
    );
  });
});
