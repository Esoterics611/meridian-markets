import { ConfigService } from '@nestjs/config';
import { TreasuryService } from './treasury.service';
import { YieldSyncCron } from './yield-sync.cron';

function cfg(nodeEnv: 'test' | 'development', intervalMs = 1000): ConfigService {
  return {
    getOrThrow: () => ({
      nodeEnv,
      yield: { syncIntervalMs: intervalMs },
    }),
  } as unknown as ConfigService;
}

describe('YieldSyncCron', () => {
  it('does NOT start the interval in test mode', () => {
    const svc = { syncYield: jest.fn() } as unknown as TreasuryService;
    const cron = new YieldSyncCron(cfg('test'), svc);
    cron.onModuleInit();
    expect((cron as unknown as { handle: NodeJS.Timeout | null }).handle).toBeNull();
    cron.onModuleDestroy();
  });

  it('tick() forwards to TreasuryService.syncYield()', async () => {
    const syncYield = jest.fn().mockResolvedValue(null);
    const svc = { syncYield } as unknown as TreasuryService;
    const cron = new YieldSyncCron(cfg('test'), svc);
    await cron.tick();
    expect(syncYield).toHaveBeenCalledTimes(1);
  });

  it('tick() swallows TreasuryService errors so the interval survives', async () => {
    const syncYield = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = { syncYield } as unknown as TreasuryService;
    const cron = new YieldSyncCron(cfg('test'), svc);
    await expect(cron.tick()).resolves.toBeUndefined();
    expect(syncYield).toHaveBeenCalledTimes(1);
  });
});
