import { CarryController } from './carry.controller';
import { CarryReadService, carryDbOffView } from './carry-read.service';

describe('CarryController', () => {
  it('GET /api/carry/state returns the service view verbatim (incl. the honest dbOff)', async () => {
    const view = carryDbOffView(1_783_100_000_000);
    const svc = { deskView: async () => view } as unknown as CarryReadService;
    await expect(new CarryController(svc).state()).resolves.toBe(view);
  });
});
