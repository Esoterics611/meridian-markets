import { firstValueFrom, take } from 'rxjs';
import { ExecController } from './exec.controller';
import { MmPortfolioTrader, MmPortfolioSnapshot } from './../market-making/live/mm-portfolio-trader';
import { CarryReadService, carryDbOffView, CarryDeskView } from '../market-making/carry/carry-read.service';

// Controller-level wiring test: the page renders from the injected trader + carry
// read service (the fund view, U2), and the SSE stream emits a JSON-able { html }
// frame on connect (startWith ⇒ immediate). This guards the contract the
// <desk-feed> client depends on (JSON.parse(ev.data).html).

function fakeSnapshot(): MmPortfolioSnapshot {
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
  };
}

function fakeTrader(): MmPortfolioTrader {
  return { snapshot: () => fakeSnapshot() } as unknown as MmPortfolioTrader;
}

function fakeCarry(view: CarryDeskView = carryDbOffView(1_783_100_000_000)): CarryReadService {
  return { deskView: async () => view } as unknown as CarryReadService;
}

describe('ExecController', () => {
  it('GET /exec renders the full fund page from the trader snapshot + carry view', async () => {
    const c = new ExecController(fakeTrader(), fakeCarry());
    const html = await c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="exec-live"');
    expect(html).toContain('desk nav');
    expect(html).toContain('carry desk'); // the U2 strip is on the fund view
  });

  it('GET /exec/stream emits an { html } frame immediately on subscribe', async () => {
    const c = new ExecController(fakeTrader(), fakeCarry());
    const frame = await firstValueFrom(c.stream().pipe(take(1)));
    expect(frame.data).toBeDefined();
    const data = frame.data as { html: string };
    expect(typeof data.html).toBe('string');
    // the streamed fragment is the live region only (no <html> doc wrapper)
    expect(data.html).toContain('stat-grid');
    expect(data.html).not.toContain('<!doctype html>');
    // carry rides the same live region, so its state refreshes with the tick
    expect(data.html).toContain('carry desk');
  });
});
