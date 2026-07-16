import { Controller, Get, Header, Inject, MessageEvent, Optional, Query, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { MmNavRepository } from '../market-making/persistence/mm-nav.repository';
import { mmStrategyRegistry } from '../market-making/registry/mm-strategy-registry';
import { listMmPresets } from '../market-making/markets/mm-market-presets';
import { renderMmDeskPage, renderMmDeskLive, MmDeskState } from './render/mm-desk-view';
import { buildNavChartSpec, ChartResponse, FillMarkerInput } from './render/chart-spec';
import { DRAWDOWN_BUDGET_PCT } from './render/components';

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
/** Fill events considered for chart markers (the ring buffer's recent window). */
const CHART_FILL_LIMIT = 200;

/** Clamp the chart window: 1h..168h (7d), default 48h — mirrors the /nav clamp. */
function clampChartHours(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 48;
  return Math.max(1, Math.min(168, Math.floor(n)));
}

@Controller()
export class MmDeskController {
  constructor(
    private readonly mm: MmPortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
    @Optional() @Inject(MmNavRepository) private readonly navRepo: MmNavRepository | null = null,
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

  /**
   * The ChartSpec behind the /desk/mm chart drawers (UI_REWRITE_PLAN_III P1):
   * durable-NAV equity + running drawdown vs the 2% budget + the cumulative P&L
   * components, per book (`?book=BTC`, with fill markers from the event tape) or
   * for the desk aggregate (no `book`). Server-built spec; <mkt-chart> renders it
   * verbatim. Honest offs: MM_PERSIST unset / DB unreachable / not enough samples.
   */
  @Get('desk/mm/chart')
  async chart(@Query('book') book = '', @Query('hours') hours?: string): Promise<ChartResponse> {
    if (!this.navRepo) return { enabled: false, reason: 'durable NAV off — set MM_PERSIST (needs Postgres)' };
    const h = clampChartHours(hours);
    let points;
    try {
      points = await this.navRepo.navHistory(new Date(Date.now() - h * 3_600_000), book);
    } catch {
      return { enabled: false, reason: 'database unreachable — the durable NAV curve needs Postgres on :5433' };
    }
    // Fill markers only make sense on one book's curve; the tape's ring buffer is
    // the source (recent fills only — the buffer is bounded, and the chart says so).
    const fills: FillMarkerInput[] = book && this.eventLog
      ? this.eventLog
          .recent({ limit: CHART_FILL_LIMIT, book })
          .filter((e) => e.kind === 'fill' && e.side)
          .map((e) => ({ ts: e.ts, side: e.side as FillMarkerInput['side'], action: e.action, realisedDeltaUnits: e.realisedDeltaUnits }))
      : [];
    return buildNavChartSpec({
      title: book ? `${book} — equity · drawdown · P&L components (${h}h)` : `MM desk — equity · drawdown · P&L components (${h}h)`,
      points,
      ddBudgetPct: DRAWDOWN_BUDGET_PCT,
      fills,
      note:
        'from the append-only mm_nav table (persisted per interval); the curve moves on the persist cadence, not per tick' +
        (book ? '; ▲/▼ fill markers come from the in-memory tape, so only recent fills are marked' : ''),
    });
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
