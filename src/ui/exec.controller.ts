import { Controller, Get, Header, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { renderExecPage, renderExecLive } from './render/exec-view';

// The Executive role page (UI_REDESIGN_PROMPT.md §2) — the first vertical slice
// of the role-scoped redesign. Read-only by construction: it injects the live MM
// desk (the same MmPortfolioTrader the snapshot/health endpoints read — DC-3, read
// the ledger, don't duplicate it) and renders it server-side. No control plane here.
//
//   GET /exec         — the server-rendered page (correct on first paint)
//   GET /exec/stream  — SSE: the live region re-rendered every tick (replaces 4s polling)

/** How often the exec live region is pushed to connected clients. */
const EXEC_STREAM_MS = 2000;

@Controller()
export class ExecController {
  constructor(private readonly mm: MmPortfolioTrader) {}

  @Get('exec')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderExecPage(this.mm.snapshot());
  }

  @Sse('exec/stream')
  stream(): Observable<MessageEvent> {
    // startWith(0) → push the current state immediately on connect, then every tick.
    return interval(EXEC_STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderExecLive(this.mm.snapshot()).value } }) as MessageEvent),
    );
  }
}
