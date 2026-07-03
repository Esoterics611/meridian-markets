import { Controller, Get, Header, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, startWith, switchMap } from 'rxjs';
import { CarryReadService } from '../market-making/carry/carry-read.service';
import { renderCarryLive, renderCarryPage } from './render/carry-desk-view';

// The funding-carry desk role page (UI_REWRITE_PLAN_II U1) — a read-only
// projection of the carry runner's durable checkpoints (the runner is a separate
// supervised process; the app never drives it). Same controller shape as
// /desk/markout.
//
//   GET /desk/carry         — full page (correct on first paint)
//   GET /desk/carry/stream  — SSE: the live region
//
// 5s cadence: the runner checkpoints every ~60s, so the stream's job is the
// LIVENESS banner staying honest, not high-frequency data.

const CARRY_STREAM_MS = 5000;

@Controller()
export class CarryDeskController {
  constructor(private readonly carry: CarryReadService) {}

  @Get('desk/carry')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(): Promise<string> {
    return renderCarryPage(await this.carry.deskView());
  }

  @Sse('desk/carry/stream')
  stream(): Observable<MessageEvent> {
    return interval(CARRY_STREAM_MS).pipe(
      startWith(0),
      switchMap(async () => ({ data: { html: renderCarryLive(await this.carry.deskView()).value } }) as MessageEvent),
    );
  }
}
