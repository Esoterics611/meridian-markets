import { firstValueFrom, take } from 'rxjs';
import { RiskController } from './risk.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';

function snap(over: Partial<MmPortfolioSnapshot> = {}): MmPortfolioSnapshot {
  return {
    running: true,
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
  return { snapshot: () => snap(over) } as unknown as MmPortfolioTrader;
}

describe('RiskController', () => {
  it('GET /risk renders the risk console', () => {
    const c = new RiskController(fakeTrader());
    const html = c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="risk-live"');
    expect(html).toContain('max book drawdown');
  });

  it('feeds the tape with verdict events only (filters out fills/lifecycle)', () => {
    const log = new DeskEventLog();
    log.emit({ ts: Date.now(), desk: 'mm', kind: 'fill', book: 'BTC', source: '', message: 'BTC ▸ BUY filled' });
    log.emit({ ts: Date.now(), desk: 'mm', kind: 'verdict', book: 'BTC', source: '', message: 'BTC ▸ risk Allow → Deny (quoting blocked)', verdict: 'Deny', prevVerdict: 'Allow' });
    const c = new RiskController(fakeTrader(), log);
    const html = c.page();
    expect(html).toContain('Allow → Deny'); // the verdict event
    expect(html).not.toContain('BUY filled'); // the fill is filtered out of the risk feed
  });

  it('degrades to an empty verdict feed without a DeskEventLog', () => {
    const c = new RiskController(fakeTrader());
    expect(c.page()).toContain('no verdict changes yet');
  });

  it('GET /risk/stream emits an { html } region frame (table + verdict feed, not a full doc)', async () => {
    const c = new RiskController(fakeTrader());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    const data = frame.data as { html: string };
    expect(data.html).toContain('book-table');
    expect(data.html).toContain('risk-verdict transitions');
    expect(data.html).not.toContain('<!doctype html>');
    expect(data.html).not.toContain('class="action-palette"'); // de-risk palette is static chrome
  });
});
