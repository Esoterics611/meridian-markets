import { Controller, Get, Query } from '@nestjs/common';
import { OpportunityScanner } from './opportunity-scanner';

// Control plane for the cross-asset opportunity scanner. A GET triggers a live
// sweep (real Binance klines) over the preset universe and returns the ranked
// net-edge-after-fees board — the desk's "scan wide, trade rarely" shortlist.
//
//   GET /api/opportunities            — scan every preset (slower; fetches all symbols)
//   GET /api/opportunities?preset=ID  — scan one preset (fast)
//
// The sweep is read-only and on-demand; the UI shows a "scanning…" state while
// it runs. Each row carries netEdgePerDayBps + whether it clears the fee gate,
// so the desk can launch only the names that actually pay.
@Controller('api/opportunities')
export class OpportunityController {
  constructor(private readonly scanner: OpportunityScanner) {}

  @Get()
  async scan(@Query('preset') preset?: string) {
    const filter = preset && preset !== 'all' ? [preset] : undefined;
    return this.scanner.scan(filter);
  }
}
