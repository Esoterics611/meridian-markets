import { firstValueFrom, take } from 'rxjs';
import { StatArbDeskController } from './statarb-desk.controller';
import { LivePortfolioTrader, PortfolioBookRow, PortfolioSnapshot } from '../execution/live-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { ReplayEngine } from '../market-data/replay/replay-engine';
import { Bar } from '../stat-arb/backtest/bar';

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

function bookRow(over: Partial<PortfolioBookRow> = {}): PortfolioBookRow {
  return {
    pair: 'ETH/BTC',
    symbolA: 'ETH',
    symbolB: 'BTC',
    strategyId: 'pairs-zscore',
    beta: 0.05,
    feedId: 'binance.spot',
    lastZ: 1.2,
    regime: 'mean-reverting',
    running: true,
    barsSeen: 200,
    lastBarAt: null,
    seededBars: 0,
    blockedEntries: 0,
    capitalUnits: '10000000000',
    equityUnits: '10000000000',
    realisedPnlUnits: '0',
    unrealisedPnlUnits: '0',
    position: null,
    ...over,
  };
}

/** Synthetic aligned 1m bars with an oscillating spread (enough to warm a z-window). */
function syntheticBars(n = 240): { a: Bar[]; b: Bar[] } {
  const t0 = Date.parse('2026-07-15T00:00:00Z');
  const mk = (symbol: string, base: number, wobble: (i: number) => number): Bar[] =>
    Array.from({ length: n }, (_, i) => {
      const close = base + wobble(i);
      return { symbol, timestamp: new Date(t0 + i * 60_000), open: close, high: close, low: close, close, volume: 1 };
    });
  return {
    a: mk('ETH', 2000, (i) => Math.sin(i / 9) * 8),
    b: mk('BTC', 60000, (i) => Math.sin(i / 13) * 40),
  };
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

  it('GET /desk/statarb/chart refuses honestly without the replay engine / for an unknown pair', async () => {
    const noReplay = await new StatArbDeskController(fakePortfolio()).chart('ETH/BTC');
    expect(noReplay.enabled).toBe(false);
    if (!noReplay.enabled) expect(noReplay.reason).toContain('replay engine');

    const replay = { loadPairWindow: async () => syntheticBars() } as unknown as ReplayEngine;
    const unknown = await new StatArbDeskController(fakePortfolio(), null, undefined, replay).chart('DOGE/BTC');
    expect(unknown.enabled).toBe(false);
    if (!unknown.enabled) expect(unknown.reason).toContain('no live pair');
  });

  it('GET /desk/statarb/chart refuses honestly when the stored-bar read throws (no DB)', async () => {
    const replay = {
      loadPairWindow: async () => {
        throw new Error('no DB');
      },
    } as unknown as ReplayEngine;
    const c = new StatArbDeskController(fakePortfolio({ books: [bookRow()] }), null, undefined, replay);
    const out = await c.chart('ETH/BTC');
    expect(out.enabled).toBe(false);
    if (!out.enabled) expect(out.reason).toContain('Postgres');
  });

  it('GET /desk/statarb/chart replays the LIVE pair (its β/strategy/venue) into the legs/z/position spec', async () => {
    const seen: Record<string, unknown>[] = [];
    const replay = {
      loadPairWindow: async (w: Record<string, unknown>) => {
        seen.push(w);
        return syntheticBars();
      },
    } as unknown as ReplayEngine;
    const c = new StatArbDeskController(fakePortfolio({ books: [bookRow({ beta: 0.033, feedId: 'binance.spot' })] }), null, undefined, replay);
    const out = await c.chart('ETH/BTC');
    expect(seen[0]).toMatchObject({ venue: 'binance.spot', symbolA: 'ETH', symbolB: 'BTC' });
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    expect(out.title).toContain('ETH/BTC');
    expect(out.title).toContain('β=0.033');
    const [legs, zPanel, posPanel] = out.panels;
    expect(legs.series.map((s) => s.name)).toEqual(['ETH', 'BTC']);
    expect(legs.series[0].data[0].value).toBeCloseTo(100); // indexed, not a dual axis
    // the live strategy's real registry bands ride the z panel (pairs-zscore: ±2 / ±0.5)
    const bandValues = zPanel.series[0].priceLines!.map((l) => l.value);
    expect(bandValues).toContain(2);
    expect(bandValues).toContain(-2);
    expect(posPanel.series[0].type).toBe('histogram');
  });

  it('GET /desk/statarb renders a chart drawer per live pair (outside the SSE region)', async () => {
    const c = new StatArbDeskController(fakePortfolio({ books: [bookRow()] }));
    const html = await c.page();
    expect(html).toContain('src="/desk/statarb/chart?pair=ETH%2FBTC"');
    expect(html).toContain('class="chart-drawer"');
    // outside the SSE region: after the live div closes
    expect(html.indexOf('id="statarb-live"')).toBeLessThan(html.indexOf('chart-drawer'));
  });

  it('GET /desk/statarb/stream emits an { html } region frame (cards only; tape + blotter are static)', async () => {
    const c = new StatArbDeskController(fakePortfolio());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(data.html).toContain('book-cards');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('blotter'); // durable blotter is page-load only, not streamed
    // the Activity tape is the static append-mode <activity-tape>, not streamed each tick
    expect(data.html).not.toContain('activity-tape');
    expect(data.html).not.toContain('class="panel activity"');
  });
});
