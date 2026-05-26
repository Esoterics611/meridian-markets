import { MockYieldProvider } from './mock-yield-provider';
import { YieldProviderInsufficientError } from './yield-provider.interface';

// 1 USDC = 1_000_000 units (6 decimals).
const ONE_USDC = 1_000_000n;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('MockYieldProvider', () => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  let provider: MockYieldProvider;

  beforeEach(() => {
    now = 1_700_000_000_000;
    // 5% APR, 0ms simulated latency for tests
    provider = new MockYieldProvider(0.05, 0, clock);
  });

  it('exposes a stable providerId', () => {
    expect(provider.providerId).toBe('mock');
  });

  it('starts with zero principal and zero yield', async () => {
    const pos = await provider.fetchPosition();
    expect(pos.principalUnits).toBe(0n);
    expect(pos.yieldEarnedUnits).toBe(0n);
  });

  it('deposits add to principal', async () => {
    await provider.deposit({ amountUnits: 1000n * ONE_USDC, idempotencyKey: 'd1' });
    const pos = await provider.fetchPosition();
    expect(pos.principalUnits).toBe(1000n * ONE_USDC);
  });

  it('replays the same idempotency key without changing principal', async () => {
    const a = await provider.deposit({ amountUnits: 500n * ONE_USDC, idempotencyKey: 'rep' });
    const b = await provider.deposit({ amountUnits: 500n * ONE_USDC, idempotencyKey: 'rep' });
    expect(a.externalRef).toBe(b.externalRef);
    const pos = await provider.fetchPosition();
    expect(pos.principalUnits).toBe(500n * ONE_USDC); // not doubled
  });

  it('withdrawals reduce principal', async () => {
    await provider.deposit({ amountUnits: 1000n * ONE_USDC, idempotencyKey: 'd1' });
    await provider.withdraw({ amountUnits: 400n * ONE_USDC, idempotencyKey: 'w1' });
    const pos = await provider.fetchPosition();
    expect(pos.principalUnits).toBe(600n * ONE_USDC);
  });

  it('refuses to over-withdraw', async () => {
    await provider.deposit({ amountUnits: 100n * ONE_USDC, idempotencyKey: 'd1' });
    await expect(
      provider.withdraw({ amountUnits: 200n * ONE_USDC, idempotencyKey: 'w1' }),
    ).rejects.toBeInstanceOf(YieldProviderInsufficientError);
  });

  it('accrues yield over wall-clock time at the configured APR', async () => {
    await provider.deposit({ amountUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'd1' });
    // Advance exactly one year.
    now += YEAR_MS;
    const pos = await provider.fetchPosition();
    // 5% of 1_000_000 USDC = 50_000 USDC ± rounding.
    const expected = 50_000n * ONE_USDC;
    const diff = pos.yieldEarnedUnits > expected
      ? pos.yieldEarnedUnits - expected
      : expected - pos.yieldEarnedUnits;
    expect(diff).toBeLessThan(ONE_USDC); // within < $1 of the closed-form answer
  });

  it('is deterministic across runs (same inputs → same outputs)', async () => {
    const a = new MockYieldProvider(0.05, 0, clock);
    const b = new MockYieldProvider(0.05, 0, clock);
    await a.deposit({ amountUnits: 1000n * ONE_USDC, idempotencyKey: 'd1' });
    await b.deposit({ amountUnits: 1000n * ONE_USDC, idempotencyKey: 'd1' });
    now += YEAR_MS / 2;
    const pa = await a.fetchPosition();
    const pb = await b.fetchPosition();
    expect(pa.yieldEarnedUnits).toBe(pb.yieldEarnedUnits);
  });

  it('does not accrue yield while principal is zero', async () => {
    now += YEAR_MS; // nothing deposited yet
    const pos = await provider.fetchPosition();
    expect(pos.yieldEarnedUnits).toBe(0n);
  });

  it('continues accruing after a withdraw on the remaining principal', async () => {
    await provider.deposit({ amountUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'd1' });
    now += YEAR_MS / 2; // ~2.5% on full principal
    await provider.withdraw({ amountUnits: 500_000n * ONE_USDC, idempotencyKey: 'w1' });
    now += YEAR_MS / 2; // ~2.5% on remaining half
    const pos = await provider.fetchPosition();
    // Expected total: 0.025 * 1_000_000 + 0.025 * 500_000 = 37_500 USDC
    const expected = 37_500n * ONE_USDC;
    const diff = pos.yieldEarnedUnits > expected
      ? pos.yieldEarnedUnits - expected
      : expected - pos.yieldEarnedUnits;
    expect(diff).toBeLessThan(10n * ONE_USDC); // < $10 drift from closed-form
  });
});
