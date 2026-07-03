import { CarryDeskController } from './carry-desk.controller';
import { CarryReadService, carryDbOffView } from '../market-making/carry/carry-read.service';

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
});
