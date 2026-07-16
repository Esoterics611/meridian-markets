import { Controller, Get, Header, Inject, MessageEvent, Optional, Query, Sse } from '@nestjs/common';
import { Observable, interval, startWith, switchMap } from 'rxjs';
import { CarryReadService } from '../market-making/carry/carry-read.service';
import { MmNavRepository } from '../market-making/persistence/mm-nav.repository';
import { renderCarryLive, renderCarryPage } from './render/carry-desk-view';
import { buildNavChartSpec, ChartResponse } from './render/chart-spec';

// The funding-carry desk role page (UI_REWRITE_PLAN_II U1) — a read-only
// projection of the carry runner's durable checkpoints (the runner is a separate
// supervised process; the app never drives it). Same controller shape as
// /desk/markout.
//
//   GET /desk/carry         — full page (correct on first paint)
//   GET /desk/carry/stream  — SSE: the live region
//   GET /desk/carry/chart   — ChartSpec: the @carry durable curve (P1 drawers)
//
// 5s cadence: the runner checkpoints every ~60s, so the stream's job is the
// LIVENESS banner staying honest, not high-frequency data.

const CARRY_STREAM_MS = 5000;
/** The P0 pre-registered desk drawdown budget (carry-desk-live.ts CD_DD_BUDGET_FRAC). */
const CARRY_DD_BUDGET_PCT = 0.5;

/** Clamp the chart window: 1h..720h (30d — the P0 run's length), default 72h. */
function clampCarryChartHours(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 72;
  return Math.max(1, Math.min(720, Math.floor(n)));
}

@Controller()
export class CarryDeskController {
  constructor(
    private readonly carry: CarryReadService,
    @Optional() @Inject(MmNavRepository) private readonly navRepo: MmNavRepository | null = null,
  ) {}

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

  /**
   * The ChartSpec behind the /desk/carry chart drawers (UI_REWRITE_PLAN_III P1):
   * the runner's durable `@carry` curve — equity, running drawdown vs the 0.5%
   * kill budget, and the cumulative components (funding is the business here; the
   * fees line shows what execution costs ate). `?book=SYM` → the `@carry:SYM`
   * per-book curve. Same mm_nav table the runner checkpoints into.
   */
  @Get('desk/carry/chart')
  async chart(@Query('book') book = '', @Query('hours') hours?: string): Promise<ChartResponse> {
    if (!this.navRepo) return { enabled: false, reason: 'durable NAV off — the carry curve needs MM_PERSIST + Postgres' };
    const h = clampCarryChartHours(hours);
    const bookKey = book ? `@carry:${book}` : '@carry';
    let points;
    try {
      points = await this.navRepo.navHistory(new Date(Date.now() - h * 3_600_000), bookKey);
    } catch {
      return { enabled: false, reason: 'database unreachable — the carry curve needs Postgres on :5433' };
    }
    return buildNavChartSpec({
      title: book ? `carry ${book} — equity · drawdown · components (${h}h)` : `carry desk — equity · drawdown · components (${h}h)`,
      points,
      ddBudgetPct: CARRY_DD_BUDGET_PCT,
      note: 'from the carry runner’s durable mm_nav checkpoints (~per minute); funding is the earner, fees are the cost of the legs — realised-first stays the judged number on the table above',
    });
  }
}
