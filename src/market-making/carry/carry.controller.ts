import { Controller, Get } from '@nestjs/common';
import { CarryReadService } from './carry-read.service';

// The carry desk's machine-readable surface (the JSON twin of /desk/carry —
// UI_REWRITE_PLAN_II U1; the standing rule: every live surface is machine-readable,
// not screen-only). Read-only: the runner is a separate supervised process and the
// app never drives it. Money fields are serialised 6-dec unit strings; `dbOff` and
// liveness say the honest thing when there is nothing to read.
//
//   GET /api/carry/state — liveness + books + desk aggregates
@Controller('api/carry')
export class CarryController {
  constructor(private readonly carry: CarryReadService) {}

  @Get('state')
  async state() {
    return this.carry.deskView();
  }
}
