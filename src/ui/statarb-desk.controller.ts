import { Controller, Get, Header, Inject, MessageEvent, Optional, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { LivePortfolioTrader } from '../execution/live-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { strategyRegistry } from '../stat-arb/strategies/strategy-registry';
import { renderStatArbPage, renderStatArbLive, StatArbDeskState, BlotterRow } from './render/statarb-desk-view';

// The stat-arb-desk role page (UI_REDESIGN_PROMPT.md §2) — mirrors /desk/mm for the
// stat-arb desk: per-pair z/β/regime + open positions + the persisted blotter + the
// Activity tape (read), and launch/stop/remove/reconfigure (write, via the existing
// /api/stat-arb/live/* control plane).
//
// NOTE on wiring (UI_ARCHITECTURE.md §7): unlike the MM/exec/ops pages, this
// controller is declared in StatArbModule, not UiModule. StatArbModule's provider
// graph (clients + StatArbRepository's required DbService) won't compile under
// UiModule's light, ConfigModule-only DI test — so we put the controller where its
// data already resolves (the same pattern as TelemetryModule owning HealthController).
// The views/specs still live in src/ui/render. It injects the STAT-ARB DeskEventLog
// instance (separate from the MM one) for its own tape.
//
//   GET /desk/statarb         — full console (correct on first paint; blotter from DB)
//   GET /desk/statarb/stream  — SSE: summary + per-pair cards + Activity tape (in-memory)

const STREAM_MS = 2000;
const TAPE_LIMIT = 40;
const BLOTTER_LIMIT = 25;
// The paper venue is the demo's mode; the blotter panel labels itself so as not to
// imply it spans every venue. (A mode-aware venue is a small later refinement.)
const BLOTTER_VENUE = 'paper';

@Controller()
export class StatArbDeskController {
  constructor(
    private readonly portfolio: LivePortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
    @Optional() private readonly repo?: StatArbRepository,
  ) {}

  @Get('desk/statarb')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(): Promise<string> {
    return renderStatArbPage(await this.buildState());
  }

  @Sse('desk/statarb/stream')
  stream(): Observable<MessageEvent> {
    // Only the in-memory snapshot + tape stream; the durable blotter (a DB read) is
    // rendered once on page load to avoid a Postgres query every tick.
    return interval(STREAM_MS).pipe(
      startWith(0),
      map(() => ({ data: { html: renderStatArbLive(this.portfolio.snapshot(), this.recentEvents()).value } }) as MessageEvent),
    );
  }

  private recentEvents() {
    return this.eventLog ? this.eventLog.recent({ limit: TAPE_LIMIT }) : [];
  }

  private async buildState(): Promise<StatArbDeskState> {
    let blotter: BlotterRow[] = [];
    let blotterAvailable = false;
    if (this.repo) {
      try {
        const rows = await this.repo.recentTrades(BLOTTER_VENUE, BLOTTER_LIMIT); // newest-first
        blotter = rows.map((t) => ({
          pair: `${t.symbolA}/${t.symbolB}`,
          side: t.side,
          entryZ: t.entryZ,
          exitZ: t.exitZ,
          pnlUnits: t.pnlUnits.toString(),
          closedAt: t.closedAt.toISOString(),
        }));
        blotterAvailable = true;
      } catch {
        // No DB / persistence off ⇒ show the "needs Postgres" note, not a 500.
        blotterAvailable = false;
      }
    }
    return {
      snap: this.portfolio.snapshot(),
      events: this.recentEvents(),
      blotter,
      blotterAvailable,
      strategies: strategyRegistry.liveCapable().map((d) => ({ id: d.id, label: d.label })),
    };
  }
}
