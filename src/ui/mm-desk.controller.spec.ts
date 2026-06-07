import { firstValueFrom, take } from 'rxjs';
import { MmDeskController } from './mm-desk.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';

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
