import { firstValueFrom, take } from 'rxjs';
import { StatArbDeskController } from './statarb-desk.controller';
import { LivePortfolioTrader, PortfolioSnapshot } from '../execution/live-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    running: false,
    feedId: 'binance.spot',
    venueId: 'paper',
    pairCount: 0,
    capitalUnits: '100000000000',
    equityUnits: '100000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    books: [],
    ...over,
  };
}

function fakePortfolio(over: Partial<PortfolioSnapshot> = {}): LivePortfolioTrader {
  return { snapshot: () => snap(over) } as unknown as LivePortfolioTrader;
}

describe('StatArbDeskController', () => {
  it('GET /desk/statarb renders the console with the real strategy catalogue', async () => {
    const c = new StatArbDeskController(fakePortfolio());
    const html = await c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="statarb-live"');
    expect(html).toContain('value="pairs-zscore"'); // real strategyRegistry
  });

  it('renders the persisted blotter from the repository (newest-first as given)', async () => {
    const repo = {
      recentTrades: async () => [
        {
          id: 1,
          venue: 'paper',
          symbolA: 'ETH',
          symbolB: 'BTC',
          side: 'SHORT' as const,
          entryZ: 1.8,
          exitZ: 0.2,
          notionalUnits: 0n,
          pnlUnits: 125000000n,
          feesUnits: 0n,
          openedAt: new Date('2026-06-06T11:00:00Z'),
          closedAt: new Date('2026-06-06T11:30:00Z'),
        },
      ],
    } as unknown as StatArbRepository;
    const c = new StatArbDeskController(fakePortfolio(), null, repo);
    const html = await c.page();
    expect(html).toContain('ETH/BTC');
    expect(html).toContain('+$125.00');
  });

  it('degrades to the needs-Postgres note when the blotter read throws (no DB)', async () => {
    const repo = {
      recentTrades: async () => {
        throw new Error('no DB');
      },
    } as unknown as StatArbRepository;
    const c = new StatArbDeskController(fakePortfolio(), null, repo);
    expect(await c.page()).toContain('persists with Postgres');
  });

  it('server-renders the Activity tape from the injected stat-arb DeskEventLog', async () => {
    const log = new DeskEventLog();
    log.emit({ ts: Date.now(), desk: 'stat-arb', kind: 'launch', book: 'ETH/BTC', source: '', message: 'ETH/BTC ▸ launched' });
    const c = new StatArbDeskController(fakePortfolio(), log);
    expect(await c.page()).toContain('ETH/BTC ▸ launched');
  });

  it('GET /desk/statarb/stream emits an { html } region frame (no blotter, no full doc)', async () => {
    const c = new StatArbDeskController(fakePortfolio());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(data.html).toContain('book-cards');
    expect(data.html).toContain('activity');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('blotter'); // durable blotter is page-load only, not streamed
  });
});
