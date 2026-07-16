import { firstValueFrom, take } from 'rxjs';
import { MmDeskController } from './mm-desk.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { MmNavRepository, MmNavRow } from '../market-making/persistence/mm-nav.repository';

function navRow(sec: number, equity: number, bookKey = ''): MmNavRow {
  return {
    id: String(sec),
    createdAt: new Date(sec * 1000),
    asOf: new Date(sec * 1000),
    bookKey,
    equityUnits: BigInt(Math.round(equity * 1e6)),
    netPnlUnits: 0n,
    realisedPnlUnits: 0n,
    unrealisedPnlUnits: 0n,
    feesUnits: 0n,
    fundingUnits: 0n,
    inventoryUnits: 0n,
    maxDrawdownPct: 0,
  };
}

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

function fakeTrader(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioTrader {
  return { snapshot: () => mmSnap(over) } as unknown as MmPortfolioTrader;
}

describe('MmDeskController', () => {
  it('GET /desk/mm renders the console with the real strategy + preset catalogues', () => {
    const c = new MmDeskController(fakeTrader());
    const html = c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="mm-live"');
    // real registries feed the launch form (not mocked) — sanity-check known ids
    expect(html).toContain('value="mm-glft"');
    expect(html).toContain('value="hl-perps"');
  });

  it('server-renders the Activity tape from the injected DeskEventLog', () => {
    const log = new DeskEventLog();
    log.emit({ ts: Date.now(), desk: 'mm', kind: 'launch', book: 'BTC', source: '', message: 'BTC ▸ launched' });
    const c = new MmDeskController(fakeTrader(), log);
    expect(c.page()).toContain('BTC ▸ launched');
  });

  it('degrades to an empty tape when no DeskEventLog is wired (optional dep)', () => {
    const c = new MmDeskController(fakeTrader());
    expect(c.page()).toContain('no activity yet');
  });

  it('GET /desk/mm/chart refuses honestly when persistence is off / the DB read throws', async () => {
    const off = await new MmDeskController(fakeTrader()).chart('');
    expect(off.enabled).toBe(false);
    if (!off.enabled) expect(off.reason).toContain('MM_PERSIST');

    const throwing = { navHistory: async () => { throw new Error('no DB'); } } as unknown as MmNavRepository;
    const down = await new MmDeskController(fakeTrader(), null, throwing).chart('');
    expect(down.enabled).toBe(false);
    if (!down.enabled) expect(down.reason).toContain('unreachable');
  });

  it('GET /desk/mm/chart serves the book curve with fill markers from the tape (bookKey passed through)', async () => {
    const seenKeys: string[] = [];
    const repo = {
      navHistory: async (_from: Date, bookKey: string) => {
        seenKeys.push(bookKey);
        return [navRow(60, 100, bookKey), navRow(120, 101, bookKey)];
      },
    } as unknown as MmNavRepository;
    const log = new DeskEventLog();
    log.emit({
      ts: 61_000, desk: 'mm', kind: 'fill', book: 'BTC', source: 'hyperliquid',
      message: 'BTC ▸ BUY', side: 'BUY', action: 'open', sizeUnits: '1', priceMicros: '1', inventoryUnits: '1', realisedDeltaUnits: '0', feeUnits: '0',
    });
    const c = new MmDeskController(fakeTrader(), log, repo);
    const out = await c.chart('BTC');
    expect(seenKeys).toEqual(['BTC']);
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    expect(out.title).toContain('BTC');
    expect(out.panels.map((p) => p.title)).toEqual([
      'equity (durable NAV)',
      'drawdown % vs budget',
      'P&L components (cumulative — these sum to net)',
    ]);
    const markers = out.panels[0].series[0].markers!;
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ shape: 'arrowUp', position: 'belowBar' });
    // the desk aggregate (no book) carries no fill markers — they only make sense per book
    const agg = await c.chart('');
    if (agg.enabled) expect(agg.panels[0].series[0].markers).toBeUndefined();
  });

  it('GET /desk/mm renders the charts panel: desk-aggregate drawer + one per book, outside the SSE region', () => {
    const c = new MmDeskController(fakeTrader());
    const html = c.page();
    expect(html).toContain('src="/desk/mm/chart"');
    expect(html).toContain('class="chart-drawer"');
    expect(html.indexOf('id="mm-live"')).toBeLessThan(html.indexOf('chart-drawer'));
  });

  it('GET /desk/mm/stream emits an { html } region frame (cards only; tape + form are static)', async () => {
    const c = new MmDeskController(fakeTrader());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(typeof data.html).toBe('string');
    expect(data.html).toContain('book-cards');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('class="panel launch"'); // form is static chrome, not streamed
    // the Activity tape is the static append-mode <activity-tape>, NOT streamed each tick
    expect(data.html).not.toContain('activity-tape');
    expect(data.html).not.toContain('class="panel activity"');
  });
});
