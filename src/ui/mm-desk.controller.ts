import { Controller, Get, Header, Inject, MessageEvent, Optional, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { mmStrategyRegistry } from '../market-making/registry/mm-strategy-registry';
import { listMmPresets } from '../market-making/markets/mm-market-presets';
import { renderMmDeskPage, renderMmDeskLive, MmDeskState } from './render/mm-desk-view';

// The MM-desk role page (UI_REDESIGN_PROMPT.md §2) — the rich desk console: per-book
// quotes/inventory/PnL attribution + the Activity tape (read), and launch/stop/
// remove/reconfigure (write, via the existing control plane). It injects the live MM
// desk + the MM DeskEventLog (the same instance the fills emit into — exported by
// MarketMakingModule for exactly this). The strategy/preset catalogues feed the
// launch form's selects; they are static, so only the snapshot + tape stream.
//
//   GET /desk/mm         — full console (correct on first paint)
//   GET /desk/mm/stream  — SSE: summary + per-book cards + Activity tape, every tick

const MM_DESK_STREAM_MS = 2000;
const TAPE_LIMIT = 40;

@Controller()
export class MmDeskController {
  constructor(
    private readonly mm: MmPortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
  ) {}

  @Get('desk/mm')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderMmDeskPage(this.buildState());
  }

  @Sse('desk/mm/stream')
  stream(): Observable<MessageEvent> {
    // Only the summary + per-book cards stream; the Activity tape is the append-mode
    // <activity-tape> on the static page, which self-polls /api/market-making/events.
    return interval(MM_DESK_STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderMmDeskLive(this.mm.snapshot()).value } }) as MessageEvent),
    );
  }

  private recentEvents() {
    return this.eventLog ? this.eventLog.recent({ limit: TAPE_LIMIT }) : [];
  }

  private buildState(): MmDeskState {
    return {
      snap: this.mm.snapshot(),
      events: this.recentEvents(),
      cursor: this.eventLog ? this.eventLog.lastSeq() : 0,
      strategies: mmStrategyRegistry.liveCapable().map((d) => ({ id: d.id, label: d.label })),
      presets: listMmPresets().map((p) => ({ id: p.id, label: p.label })),
    };
  }
}
