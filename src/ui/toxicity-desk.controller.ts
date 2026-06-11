import { Controller, Get, Header, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { renderToxicityPage, renderToxicityLive } from './render/toxicity-desk-view';

// The flow-toxicity role page (TRADER_UI_SPEC.md §3) — read-only view over
// MmPortfolioTrader.snapshot(): VPIN gauges (warmed-state-aware), F3 scale,
// signed imbalances + verdict chips. Same controller shape as /desk/mm.
//
//   GET /desk/toxicity         — full page (correct on first paint)
//   GET /desk/toxicity/stream  — SSE: the live gauge region, every tick

const TOXICITY_STREAM_MS = 2000;

@Controller()
export class ToxicityDeskController {
  constructor(private readonly mm: MmPortfolioTrader) {}

  @Get('desk/toxicity')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderToxicityPage(this.mm.snapshot());
  }

  @Sse('desk/toxicity/stream')
  stream(): Observable<MessageEvent> {
    return interval(TOXICITY_STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderToxicityLive(this.mm.snapshot()).value } }) as MessageEvent),
    );
  }
}
