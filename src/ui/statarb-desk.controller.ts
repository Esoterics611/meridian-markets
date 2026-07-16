import { Controller, Get, Header, Inject, MessageEvent, Optional, Query, Sse } from '@nestjs/common';
import { Observable, interval, map, startWith } from 'rxjs';
import { LivePortfolioTrader } from '../execution/live-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { strategyRegistry } from '../stat-arb/strategies/strategy-registry';
import { ReplayEngine } from '../market-data/replay/replay-engine';
import { alignPair } from '../market-data/market-data.controller';
import { BacktestRunner } from '../stat-arb/backtest/backtest-runner';
import { PairsStrategy } from '../stat-arb/backtest/pairs-strategy';
import { HistoricalReplayVenue } from '../stat-arb/historical-replay-venue';
import { renderStatArbPage, renderStatArbLive, StatArbDeskState, BlotterRow } from './render/statarb-desk-view';
import { buildPairChartSpec, ChartResponse } from './render/chart-spec';

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
/** Chart replay sizing (display only — mirrors /signal-series' fixed notional). */
const CHART_NOTIONAL_UNITS = 1_000_000_000n;

/** Clamp the pair-chart window: 6h..336h (14d), default 72h — signal-series' default. */
function clampPairChartHours(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 72;
  return Math.max(6, Math.min(336, Math.floor(n)));
}

@Controller()
export class StatArbDeskController {
  constructor(
    private readonly portfolio: LivePortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
    @Optional() private readonly repo?: StatArbRepository,
    @Optional() private readonly replay?: ReplayEngine,
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
      map(() => ({ data: { html: renderStatArbLive(this.portfolio.snapshot()).value } }) as MessageEvent),
    );
  }

  /**
   * The ChartSpec behind the /desk/statarb chart drawers (UI_REWRITE_PLAN_III P1):
   * the classic pairs picture — legs indexed to 100, the spread z with the LIVE
   * book's entry/exit bands + replay trade markers, and the position sign. It
   * replays the SAME path as /api/market-data/signal-series (stored bars →
   * alignPair → the registry strategy with the live pair's β), so the picture is
   * the same math the card's z comes from. Honest offs: unknown pair, no stored
   * bars (backfill), DB unreachable.
   */
  @Get('desk/statarb/chart')
  async chart(@Query('pair') pairQ = '', @Query('hours') hours?: string): Promise<ChartResponse> {
    if (!this.replay) return { enabled: false, reason: 'chart source unavailable — the stored-bar replay engine is not wired' };
    const book = this.portfolio.snapshot().books.find((b) => b.pair === pairQ);
    if (!book) return { enabled: false, reason: `no live pair "${pairQ}" — the chart follows a launched book's β/strategy (launch it, then reload)` };
    const h = clampPairChartHours(hours);
    const to = new Date();
    const from = new Date(to.getTime() - h * 3_600_000);
    let a, b;
    try {
      ({ a, b } = await this.replay.loadPairWindow({ venue: book.feedId, symbolA: book.symbolA, symbolB: book.symbolB, from, to }));
    } catch {
      return { enabled: false, reason: 'stored-bar window unreadable — needs Postgres on :5433 (+ a backfill for this venue)' };
    }
    const aligned = alignPair(a, b);
    if (aligned.a.length < 30) {
      return { enabled: false, reason: `not enough overlapping ${book.feedId} bars stored for ${pairQ} — run the backfill (see /research runbook)` };
    }
    const hasStrat = strategyRegistry.has(book.strategyId);
    const strategy = hasStrat
      ? strategyRegistry.build(book.strategyId, { beta: book.beta, notionalUnits: CHART_NOTIONAL_UNITS })
      : new PairsStrategy({ beta: book.beta, zLookback: 20, entryZ: 2, exitZ: 0.5, notionalUnits: CHART_NOTIONAL_UNITS });
    const replayVenue = new HistoricalReplayVenue({ [book.symbolA]: aligned.a, [book.symbolB]: aligned.b });
    const result = await new BacktestRunner().run({ barsA: aligned.a, barsB: aligned.b, strategy, venue: replayVenue });
    const defaults = hasStrat ? strategyRegistry.get(book.strategyId).defaultParams : { entryZ: 2, exitZ: 0.5 };

    const toSec = (d: Date) => Math.floor(d.getTime() / 1000);
    const series = result.spreadSeries.map((p) => ({ time: toSec(p.timestamp), z: p.zScore, position: p.position }));
    return buildPairChartSpec({
      pair: pairQ,
      strategyLabel: `${book.strategyId} · β=${book.beta.toFixed(3)} · ${book.feedId}`,
      legA: { symbol: book.symbolA, points: aligned.a.map((bar) => ({ time: toSec(bar.timestamp), value: bar.close })) },
      legB: { symbol: book.symbolB, points: aligned.b.map((bar) => ({ time: toSec(bar.timestamp), value: bar.close })) },
      z: series.map((p) => ({ time: p.time, value: p.z })),
      position: series.map((p) => ({ time: p.time, value: p.position === 'LONG' ? 1 : p.position === 'SHORT' ? -1 : 0 })),
      bands: defaults.entryZ != null ? { entryZ: defaults.entryZ, exitZ: defaults.exitZ } : null,
      trades: result.trades.map((t) => ({
        openTime: series[t.openIndex]?.time ?? null,
        closeTime: series[t.closeIndex]?.time ?? null,
        side: t.side,
        pnlUnits: t.pnlUnits.toString(),
      })),
      note:
        'replayed over the newest STORED bars with the live book’s β/strategy (the same path as /signal-series) — ' +
        'markers are the replay’s entries/exits, not the live blotter; the live card’s z updates ahead of the stored window',
    });
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
      cursor: this.eventLog ? this.eventLog.lastSeq() : 0,
      blotter,
      blotterAvailable,
      strategies: strategyRegistry.liveCapable().map((d) => ({ id: d.id, label: d.label })),
    };
  }
}
