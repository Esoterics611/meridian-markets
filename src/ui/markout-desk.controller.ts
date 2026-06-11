import { Controller, Get, Header, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { renderMarkoutPage, renderMarkoutLive } from './render/markout-desk-view';

// The markout / TCA role page (TRADER_UI_SPEC.md §2) — read-only view over
// MmPortfolioTrader.snapshot(): per-book multi-horizon markout curves by side
// + the F3 reaction. Same controller shape as /desk/mm.
//
//   GET /desk/markout         — full page (correct on first paint)
//   GET /desk/markout/stream  — SSE: the live region, every tick

const MARKOUT_STREAM_MS = 2000;

@Controller()
export class MarkoutDeskController {
  constructor(private readonly mm: MmPortfolioTrader) {}

  @Get('desk/markout')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderMarkoutPage(this.mm.snapshot());
  }

  @Sse('desk/markout/stream')
  stream(): Observable<MessageEvent> {
    return interval(MARKOUT_STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderMarkoutLive(this.mm.snapshot()).value } }) as MessageEvent),
    );
  }
}
