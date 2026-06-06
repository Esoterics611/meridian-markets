import { firstValueFrom, take } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { OpsController } from './ops.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import { DbService } from '@database/db.service';

function mmSnap(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: false,
    bookCount: 0,
    capitalUnits: '100000000000',
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    feesUnits: '0',
    fundingUnits: '0',
    netPnlUnits: '0',
    books: [],
    ...over,
  };
}

function fakeCfg(persist: boolean): ConfigService {
  return {
    getOrThrow: () => ({
      marketMaking: { persist },
      telemetry: { readyTickMultiplier: 3, feedStalenessMs: 90_000 },
    }),
  } as unknown as ConfigService;
}

function fakeTrader(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioTrader {
  return {
    snapshot: () => mmSnap(over),
    lastTickAt: () => null,
    getPollIntervalMs: () => 2000,
  } as unknown as MmPortfolioTrader;
}

describe('OpsController', () => {
  it('GET /ops renders the full operator page from live state (persistence off ⇒ no DB needed)', async () => {
    const c = new OpsController(fakeCfg(false), fakeTrader());
    const html = await c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Operator');
    expect(html).toContain('id="ops-live"');
    expect(html).toContain('>OFF<'); // MM_PERSIST off
  });

  it('pings the DB and reports it reachable when persistence is on', async () => {
    let pinged = 0;
    const db = { ping: async () => (pinged++, true) } as unknown as DbService;
    const c = new OpsController(fakeCfg(true), fakeTrader(), db);
    const html = await c.page();
    expect(pinged).toBe(1);
    expect(html).toContain('>ON<');
    expect(html).toContain('reachable');
  });

  it('reports the DB unreachable when persistence is on but no DbService is wired', async () => {
    const c = new OpsController(fakeCfg(true), fakeTrader());
    const html = await c.page();
    expect(html).toContain('unreachable');
  });

  it('GET /ops/stream emits an { html } status frame (not a full doc) on subscribe', async () => {
    const c = new OpsController(fakeCfg(false), fakeTrader());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(typeof data.html).toBe('string');
    expect(data.html).toContain('ops-grid');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('action-palette'); // palette is static chrome, not streamed
  });
});
