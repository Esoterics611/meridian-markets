import { FundingRefreshCron, FundingRateFor } from './funding-refresh.cron';
import { ConfigService } from '@nestjs/config';
import { MmPortfolioTrader } from './mm-portfolio-trader';

// Offline: a fake trader + a fake rateFor. The real HL fetch is the funding client's
// own concern (hyperliquid-funding-client.spec.ts); this asserts the cron's wiring.

function cfg(nodeEnv = 'test', fundingRefreshMs = 600_000): ConfigService {
  return { getOrThrow: () => ({ nodeEnv, marketMaking: { fundingRefreshMs } }) } as unknown as ConfigService;
}

function trader(refreshFunding: MmPortfolioTrader['refreshFunding']): MmPortfolioTrader {
  return { refreshFunding } as unknown as MmPortfolioTrader;
}

describe('FundingRefreshCron', () => {
  it('tick() refreshes funding through the trader with the injected source fn', async () => {
    let seen: FundingRateFor | null = null;
    const t = trader(async (fn) => {
      seen = fn;
      return 2;
    });
    const rateFor: FundingRateFor = async () => 0.0000125;
    const cron = new FundingRefreshCron(cfg(), t, rateFor);

    await cron.tick();
    expect(seen).toBe(rateFor); // the cron hands its source straight to the trader
  });

  it('tick() never throws even if the refresh rejects (best-effort over a multi-hour run)', async () => {
    const t = trader(async () => {
      throw new Error('refresh blew up');
    });
    const cron = new FundingRefreshCron(cfg(), t, async () => 0);
    await expect(cron.tick()).resolves.toBeUndefined();
  });

  it('onModuleInit starts no timer in test env (tick is driven explicitly)', () => {
    const t = trader(async () => 0);
    const cron = new FundingRefreshCron(cfg('test'), t, async () => 0);
    cron.onModuleInit();
    cron.onModuleDestroy(); // no-op; must not throw with no handle
  });

  it('onModuleInit starts no timer when the cadence is disabled (0)', () => {
    const t = trader(async () => 0);
    const cron = new FundingRefreshCron(cfg('production', 0), t, async () => 0);
    cron.onModuleInit();
    cron.onModuleDestroy();
  });
});
