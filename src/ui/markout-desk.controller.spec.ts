import { firstValueFrom, take } from 'rxjs';
import { MarkoutDeskController } from './markout-desk.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';

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

describe('MarkoutDeskController', () => {
  it('GET /desk/markout renders the full page from the live snapshot', () => {
    const html = new MarkoutDeskController(fakeTrader()).page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="markout-live"');
    expect(html).toContain('picked off');
  });

  it('GET /desk/markout/stream emits an { html } region frame (not a full document)', async () => {
    const frame = await firstValueFrom(new MarkoutDeskController(fakeTrader()).stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(typeof data.html).toBe('string');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).toContain('desk fills');
  });
});
