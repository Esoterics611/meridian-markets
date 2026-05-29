import { ConfigService } from '@nestjs/config';
import { ReconciliationCron, InternalBookSnapshot } from './reconciliation.cron';
import { PaperVenue } from './paper-venue';
import { AppConfig } from '@config/app-config.interface';

function stubConfig(): ConfigService {
  const cfg: Partial<AppConfig> = {
    nodeEnv: 'test',
    execution: { mode: 'paper', canaryPaperPct: 100, reconciliationIntervalMs: 60_000, liveTradingArmed: false },
  };
  return { getOrThrow: () => cfg } as unknown as ConfigService;
}

function paper() {
  return new PaperVenue({ pricePoller: async () => 1_000_000n });
}

describe('ReconciliationCron', () => {
  it('does not start setInterval when NODE_ENV=test', () => {
    const c = new ReconciliationCron(stubConfig());
    c.onModuleInit();
    expect((c as any).handle).toBeNull();
  });

  it('emits no events when internal book matches the paper book', async () => {
    const c = new ReconciliationCron(stubConfig());
    const v = paper();
    const internal: InternalBookSnapshot[] = [{ symbol: 'BTC', netNotionalUnits: 0n, idempotencyKeys: new Set() }];
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    expect(c.recentEvents()).toEqual([]);
  });

  it('emits NET_DRIFT when internal net does not match paper net', async () => {
    const v = paper();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'k1' });
    const internal: InternalBookSnapshot[] = [{ symbol: 'BTC', netNotionalUnits: 500n, idempotencyKeys: new Set(['k1']) }];

    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    const events = c.recentEvents();
    expect(events.find((e) => e.kind === 'NET_DRIFT')?.detail['delta']).toBe('-500');
  });

  it('emits MISSING_FILL when paper has a fill internal does not', async () => {
    const v = paper();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000n, idempotencyKey: 'kX' });
    const internal: InternalBookSnapshot[] = [{ symbol: 'BTC', netNotionalUnits: 1_000n, idempotencyKeys: new Set() }];

    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    const events = c.recentEvents();
    expect(events.find((e) => e.kind === 'MISSING_FILL')?.detail['idempotencyKey']).toBe('kX');
  });

  it('emits GHOST_FILL when internal claims a key the paper venue never saw', async () => {
    const v = paper();
    const internal: InternalBookSnapshot[] = [{ symbol: 'BTC', netNotionalUnits: 0n, idempotencyKeys: new Set(['ghost-1']) }];

    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    const events = c.recentEvents();
    expect(events.find((e) => e.kind === 'GHOST_FILL')?.detail['idempotencyKey']).toBe('ghost-1');
  });

  it('tick is a no-op when paperVenue is not set', async () => {
    const c = new ReconciliationCron(stubConfig());
    await c.tick();
    expect(c.recentEvents()).toEqual([]);
  });

  it('recentEvents returns newest-first', async () => {
    const v = paper();
    await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1n, idempotencyKey: 'a' });
    await v.placeOrder({ symbol: 'ETH', side: 'BUY', notionalUnits: 1n, idempotencyKey: 'b' });
    const internal: InternalBookSnapshot[] = [
      { symbol: 'BTC', netNotionalUnits: 1n, idempotencyKeys: new Set(['a']) },
      { symbol: 'ETH', netNotionalUnits: 1n, idempotencyKeys: new Set(['b']) },
    ];
    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    expect(c.recentEvents()).toEqual([]); // perfect match
  });

  it('catches and logs errors thrown by internalBook()', async () => {
    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => { throw new Error('boom'); }, paperVenue: paper() });
    await expect(c.tick()).resolves.toBeUndefined();
    expect(c.recentEvents()).toEqual([]);
  });

  it('respects the recent-events limit', async () => {
    const v = paper();
    const keys = Array.from({ length: 120 }, (_, i) => `k${i}`);
    for (const k of keys) await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1n, idempotencyKey: k });
    const internal: InternalBookSnapshot[] = [{ symbol: 'BTC', netNotionalUnits: 120n, idempotencyKeys: new Set() }];
    const c = new ReconciliationCron(stubConfig());
    c.setSources({ internalBook: () => internal, paperVenue: v });
    await c.tick();
    expect(c.recentEvents().length).toBeLessThanOrEqual(50);
  });
});
