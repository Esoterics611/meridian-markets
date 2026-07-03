import { Controller, Get, Header, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, startWith, switchMap } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { CarryReadService } from '../market-making/carry/carry-read.service';
import { renderExecPage, renderExecLive } from './render/exec-view';

// The Executive role page (UI_REDESIGN_PROMPT.md §2) — the FUND view: the MM desk
// (in-process snapshot) + the carry desk (durable checkpoints via CarryReadService
// — UI_REWRITE_PLAN_II U2). Read-only by construction; no control plane here.
//
//   GET /exec         — the server-rendered page (correct on first paint)
//   GET /exec/stream  — SSE: the live region re-rendered every tick (replaces 4s polling)

/** How often the exec live region is pushed to connected clients. */
const EXEC_STREAM_MS = 2000;

@Controller()
export class ExecController {
  constructor(
    private readonly mm: MmPortfolioTrader,
    private readonly carry: CarryReadService,
  ) {}

  @Get('exec')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(): Promise<string> {
    return renderExecPage(this.mm.snapshot(), await this.carry.deskView());
  }

  @Sse('exec/stream')
  stream(): Observable<MessageEvent> {
    // startWith(0) → push the current state immediately on connect, then every tick.
    return interval(EXEC_STREAM_MS).pipe(
      startWith(0),
      switchMap(async () => ({ data: { html: renderExecLive(this.mm.snapshot(), await this.carry.deskView()).value } }) as MessageEvent),
    );
  }
}
