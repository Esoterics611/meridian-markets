import { firstValueFrom, take } from 'rxjs';
import { ToxicityDeskController } from './toxicity-desk.controller';
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

describe('ToxicityDeskController', () => {
  it('GET /desk/toxicity renders the full page with the history strips outside the SSE region', () => {
    const html = new ToxicityDeskController(fakeTrader()).page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="tox-live"');
    expect(html).toContain('<tox-strips');
  });

  it('GET /desk/toxicity/stream emits an { html } region frame (gauges only; strips are static chrome)', async () => {
    const frame = await firstValueFrom(new ToxicityDeskController(fakeTrader()).stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(typeof data.html).toBe('string');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('<tox-strips'); // an SSE tick must not recreate the buffer
  });
});
