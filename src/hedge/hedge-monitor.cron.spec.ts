import { ConfigService } from '@nestjs/config';
import { HedgeVenueUnhealthyError } from './hedge-venue.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { HedgeService } from './hedge.service';
import { HedgeMonitorCron } from './hedge-monitor.cron';
import { IExposureClient, OutstandingExposure } from './exposure-client.interface';
import { FeedStaleError } from './hedge.errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ONE_USDC = 1_000_000n;
const FIVE_HUNDRED_K_USDC = 500_000n * ONE_USDC;

function makeCfg(
  monitorIntervalMs = 60_000,
  hedgeRatioPct = 100,
  rebalanceThresholdPct = 5,
  nodeEnv: 'test' | 'development' = 'test',
): ConfigService {
  return {
    getOrThrow: () => ({
      nodeEnv,
      hedge: {
        monitorIntervalMs,
        hedgeRatioPct,
        rebalanceThresholdPct,
        positionStalenessMs: 30_000,
        maxFundingBps: 100,
        maxFeedStalenessMs: 300_000,
        ilsSigmaBps: 94,
      },
    }),
  } as unknown as ConfigService;
}

function makeExposure(usdcUnits: bigint, ageMs = 0): OutstandingExposure {
  return {
    ilsUnits: (usdcUnits * 37n) / 10n,
    usdcUnits,
    asOf: new Date(Date.now() - ageMs),
  };
}

function makeBreaker(
  mode: 'pass' | 'venue-unhealthy' | 'feed-stale' = 'pass',
): HedgeCircuitBreaker {
  return {
    checkVenueHealth: jest.fn(() => {
      if (mode === 'venue-unhealthy') throw new HedgeVenueUnhealthyError('test');
    }),
    checkFeedStaleness: jest.fn(() => {
      if (mode === 'feed-stale') throw new FeedStaleError(400_000, 300_000);
    }),
    maxNotional: jest.fn((m: bigint) => m),
  } as unknown as HedgeCircuitBreaker;
}

function makeHedgeService(
  totalOpenNotional: bigint,
  openRefs: string[] = [],
): jest.Mocked<HedgeService> {
  return {
    getTotalOpenNotional: jest.fn().mockResolvedValue(totalOpenNotional),
    listOpenPositionRefs: jest.fn().mockResolvedValue(openRefs),
    openShort: jest.fn().mockResolvedValue({ direction: 'OPEN_SHORT', notionalUnits: 0n }),
    closeShort: jest.fn().mockResolvedValue({ direction: 'CLOSE_SHORT', notionalUnits: 0n }),
    markAll: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<HedgeService>;
}

function makeVenue(healthy = true): { fetchHealth: jest.Mock } {
  return {
    fetchHealth: jest.fn().mockResolvedValue({ healthy, lastFundingBps: 5, lastUpdate: new Date() }),
    venueId: 'mock',
  } as unknown as { fetchHealth: jest.Mock };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HedgeMonitorCron', () => {
  it('does NOT start the interval when nodeEnv = test', () => {
    const cfg = makeCfg(60_000, 100, 5, 'test');
    const hedgeSvc = makeHedgeService(0n);
    const exposure: IExposureClient = { getOutstandingExposure: jest.fn() };
    const venue = makeVenue();
    const cron = new HedgeMonitorCron(cfg, hedgeSvc, makeBreaker(), exposure, venue as never);
    cron.onModuleInit();
    expect((cron as unknown as { handle: NodeJS.Timeout | null }).handle).toBeNull();
    cron.onModuleDestroy();
  });

  it('tick opens a short when under-hedged by more than the threshold', async () => {
    // Exposure = 500k USDC; current hedge = 0 → under-hedged by 100%.
    const exposure: IExposureClient = {
      getOutstandingExposure: jest.fn().mockResolvedValue(makeExposure(FIVE_HUNDRED_K_USDC)),
    };
    const hedgeSvc = makeHedgeService(0n, []);
    const venue = makeVenue();
    const cron = new HedgeMonitorCron(
      makeCfg(), hedgeSvc, makeBreaker(), exposure, venue as never,
    );
    await cron.tick();
    expect(hedgeSvc.openShort).toHaveBeenCalledWith(
      FIVE_HUNDRED_K_USDC, expect.any(String),
    );
  });

  it('tick does nothing when already hedged within the threshold', async () => {
    // Target = 500k. Current = 497k. Delta / target = 0.6% < 5% threshold.
    const target = FIVE_HUNDRED_K_USDC;
    const current = 497_000n * ONE_USDC;
    const exposure: IExposureClient = {
      getOutstandingExposure: jest.fn().mockResolvedValue(makeExposure(target)),
    };
    const hedgeSvc = makeHedgeService(current, []);
    const venue = makeVenue();
    const cron = new HedgeMonitorCron(
      makeCfg(), hedgeSvc, makeBreaker(), exposure, venue as never,
    );
    await cron.tick();
    expect(hedgeSvc.openShort).not.toHaveBeenCalled();
    expect(hedgeSvc.closeShort).not.toHaveBeenCalled();
  });

  it('tick logs and does not rethrow when a circuit-breaker gate fires', async () => {
    const exposure: IExposureClient = {
      getOutstandingExposure: jest.fn().mockResolvedValue(makeExposure(FIVE_HUNDRED_K_USDC)),
    };
    const hedgeSvc = makeHedgeService(0n, []);
    const venue = makeVenue();
    // Breaker trips on venue health.
    const cron = new HedgeMonitorCron(
      makeCfg(), hedgeSvc, makeBreaker('venue-unhealthy'), exposure, venue as never,
    );
    // Should resolve (not reject) even though the breaker fires.
    await expect(cron.tick()).resolves.toBeUndefined();
    expect(hedgeSvc.openShort).not.toHaveBeenCalled();
  });

  it('tick calls markAll after rebalancing', async () => {
    const exposure: IExposureClient = {
      getOutstandingExposure: jest.fn().mockResolvedValue(makeExposure(0n)), // zero exposure
    };
    const hedgeSvc = makeHedgeService(0n, []);
    const venue = makeVenue();
    const cron = new HedgeMonitorCron(
      makeCfg(), hedgeSvc, makeBreaker(), exposure, venue as never,
    );
    await cron.tick();
    expect(hedgeSvc.markAll).toHaveBeenCalledTimes(1);
  });
});
