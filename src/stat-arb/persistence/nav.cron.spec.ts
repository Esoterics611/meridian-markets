import { StatArbNavCron } from './nav.cron';
import { ConfigService } from '@nestjs/config';
import { StatArbRepository, StatArbTradeRow, StatArbNavRow } from './stat-arb.repository';

function trade(pnlUnits: bigint, closedAtIso = '2026-01-01T00:00:00Z'): StatArbTradeRow {
  return {
    id: 'x', venue: 'mock', symbolA: 'BTC', symbolB: 'ETH', side: 'SHORT',
    entryZ: 1.5, exitZ: 0.2,
    entryPriceAMicros: 1n, entryPriceBMicros: 1n, exitPriceAMicros: 1n, exitPriceBMicros: 1n,
    notionalUnits: 1_000_000n, pnlUnits, feesUnits: 0n,
    openedAt: new Date(closedAtIso), closedAt: new Date(closedAtIso),
    idempotencyKey: 'k', createdAt: new Date(closedAtIso),
  };
}

function cfg(): ConfigService {
  return { getOrThrow: () => ({ nodeEnv: 'test' }) } as unknown as ConfigService;
}

function repoStub(opts: {
  trades: StatArbTradeRow[];
  insertedNav?: StatArbNavRow | null;
  onInsert?: () => void;
}): StatArbRepository {
  return {
    recentTrades: async () => opts.trades,
    insertNav: async () => {
      opts.onInsert?.();
      return opts.insertedNav ?? null;
    },
  } as unknown as StatArbRepository;
}

describe('StatArbNavCron', () => {
  it('sums pnlUnits across all recent trades', async () => {
    let insertedNavUnits: bigint | null = null;
    const repo = {
      recentTrades: async () => [trade(100n), trade(-25n), trade(50n)],
      insertNav: async (n: { navUnits: bigint }) => {
        insertedNavUnits = n.navUnits;
        return null;
      },
    } as unknown as StatArbRepository;
    const cron = new StatArbNavCron(cfg(), repo);
    await cron.tick(new Date('2026-01-01T00:00:00Z'));
    expect(insertedNavUnits).toBe(125n);
  });

  it('clamps negative NAV to 0 to satisfy the CHECK constraint', async () => {
    let insertedNavUnits: bigint | null = null;
    const repo = {
      recentTrades: async () => [trade(-200n), trade(-50n)],
      insertNav: async (n: { navUnits: bigint }) => {
        insertedNavUnits = n.navUnits;
        return null;
      },
    } as unknown as StatArbRepository;
    await new StatArbNavCron(cfg(), repo).tick();
    expect(insertedNavUnits).toBe(0n);
  });

  it('logs and swallows repo errors', async () => {
    const repo = {
      recentTrades: async () => { throw new Error('boom'); },
      insertNav: async () => null,
    } as unknown as StatArbRepository;
    await expect(new StatArbNavCron(cfg(), repo).tick()).resolves.toBeUndefined();
  });

  it('passes the provided now Date as asOf', async () => {
    let asOfSeen: Date | null = null;
    const repo = {
      recentTrades: async () => [],
      insertNav: async (n: { asOf: Date }) => {
        asOfSeen = n.asOf;
        return null;
      },
    } as unknown as StatArbRepository;
    const t = new Date('2026-02-14T12:34:56Z');
    await new StatArbNavCron(cfg(), repo).tick(t);
    expect(asOfSeen).toEqual(t);
  });

  it('skips the cron schedule when nodeEnv = test', () => {
    const cron = new StatArbNavCron(cfg(), repoStub({ trades: [] }));
    cron.onModuleInit();
    expect((cron as unknown as { handle: NodeJS.Timeout | null }).handle).toBeNull();
  });
});
