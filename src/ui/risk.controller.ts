import { Controller, Get, Header, Inject, MessageEvent, Optional, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { renderRiskPage, renderRiskLive, RiskState } from './render/risk-view';

// The Risk role page (UI_REDESIGN_PROMPT.md §2): live drawdown vs the 2% budget,
// per-book exposure + toxicity (adverse selection), risk-verdict transitions, and the
// de-risk levers. Reads the MM desk + the MM DeskEventLog (filtered to verdict
// events) — MM-snapshot data, so it lives in UiModule like /ops + /exec.
//
//   GET /risk         — server-rendered risk console (correct on first paint)
//   GET /risk/stream  — SSE: drawdown/exposure + per-book risk table + verdict feed

const RISK_STREAM_MS = 2000;
// Scan a wide window of recent events, then keep the verdict transitions.
const EVENT_SCAN = 300;
const VERDICT_LIMIT = 40;

@Controller()
export class RiskController {
  constructor(
    private readonly mm: MmPortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
  ) {}

  @Get('risk')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderRiskPage(this.buildState());
  }

  @Sse('risk/stream')
  stream(): Observable<MessageEvent> {
    return interval(RISK_STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderRiskLive(this.mm.snapshot(), this.recentVerdicts()).value } }) as MessageEvent),
    );
  }

  /** Recent risk-verdict-change events (the DeskEventLog has no kind filter, so filter here). */
  private recentVerdicts() {
    if (!this.eventLog) return [];
    return this.eventLog
      .recent({ limit: EVENT_SCAN })
      .filter((e) => e.kind === 'verdict')
      .slice(-VERDICT_LIMIT);
  }

  private buildState(): RiskState {
    return { snap: this.mm.snapshot(), verdicts: this.recentVerdicts() };
  }
}
