import { CarryDeskController } from './carry-desk.controller';
import { CarryReadService, carryDbOffView } from '../market-making/carry/carry-read.service';
import { MmNavRepository, MmNavRow } from '../market-making/persistence/mm-nav.repository';

// The controller is thin (service → render); assert the wiring, not the markup
// (the markup is carry-desk-view.spec.ts's job).

describe('CarryDeskController', () => {
  it('renders the full page from the service view', async () => {
    const svc = { deskView: async () => carryDbOffView(Date.now()) } as unknown as CarryReadService;
    const page = await new CarryDeskController(svc).page();
    expect(page).toContain('Carry desk');
    expect(page).toContain('desk-feed src="/desk/carry/stream"');
    expect(page).toContain('DB OFF'); // the honest dbOff state flows through
  });

  it('streams the live region on the SSE observable', (done) => {
    const svc = { deskView: async () => carryDbOffView(Date.now()) } as unknown as CarryReadService;
    const sub = new CarryDeskController(svc).stream().subscribe((ev) => {
      const html = (ev.data as { html: string }).html;
      expect(html).toContain('DB OFF');
      sub.unsubscribe();
      done();
    });
  });

  it('GET /desk/carry/chart maps the book param onto the @carry nav namespace (aggregate + per book)', async () => {
    const svc = { deskView: async () => carryDbOffView(Date.now()) } as unknown as CarryReadService;
    const seenKeys: string[] = [];
    const row = (sec: number, equity: number): MmNavRow => ({
      id: String(sec),
      createdAt: new Date(sec * 1000),
      asOf: new Date(sec * 1000),
      bookKey: '@carry',
      equityUnits: BigInt(Math.round(equity * 1e6)),
      netPnlUnits: 0n,
      realisedPnlUnits: 0n,
      unrealisedPnlUnits: 0n,
      feesUnits: 0n,
      fundingUnits: 0n,
      inventoryUnits: 0n,
      maxDrawdownPct: 0,
    });
    const repo = {
      navHistory: async (_from: Date, bookKey: string) => {
        seenKeys.push(bookKey);
        return [row(60, 1000), row(120, 1001)];
      },
    } as unknown as MmNavRepository;
    const c = new CarryDeskController(svc, repo);
    const agg = await c.chart('');
    const book = await c.chart('W');
    expect(seenKeys).toEqual(['@carry', '@carry:W']);
    expect(agg.enabled).toBe(true);
    if (agg.enabled) {
      // the 0.5% kill budget rides the drawdown panel
      expect(agg.panels[1].series[0].priceLines![0]).toMatchObject({ value: 0.5, title: 'budget' });
    }
    expect(book.enabled).toBe(true);
  });

  it('GET /desk/carry/chart refuses honestly without the nav repo (persistence off)', async () => {
    const svc = { deskView: async () => carryDbOffView(Date.now()) } as unknown as CarryReadService;
    const out = await new CarryDeskController(svc).chart('');
    expect(out.enabled).toBe(false);
    if (!out.enabled) expect(out.reason).toContain('MM_PERSIST');
  });
});
