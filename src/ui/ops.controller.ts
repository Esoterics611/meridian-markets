import { Controller, Get, Header, Inject, MessageEvent, Optional, Sse } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, from, interval, map, startWith, switchMap } from 'rxjs';
import { AppConfig } from '@config/app-config.interface';
import { DbService } from '@database/db.service';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { assessReadiness } from '../telemetry/readiness';
import { ITelemetry, TELEMETRY } from '../telemetry/telemetry.interface';
import { PrometheusRegistry } from '../telemetry/prometheus-registry';
import { M } from '../telemetry/metric-catalog';
import { renderOpsPage, renderOpsLive, OpsState, OpsTelemetry } from './render/ops-view';

// The Operator role page (UI_REDESIGN_PROMPT.md §2) — the second slice + the first
// ACTION page. Read panels project the readiness probe + the live MM desk (the same
// MmPortfolioTrader the control plane mutates); the action palette's buttons POST to
// the existing /api/market-making/{start,stop,flatten} endpoints (the page renders
// those buttons; it does not add new write endpoints — DC-3, reuse the validated
// control plane). It assembles the readiness inputs the same way HealthController
// does (a small, deliberate mirror; extract a ReadinessProbe if a 3rd consumer appears).
//
//   GET /ops         — server-rendered operator console (correct on first paint)
//   GET /ops/stream  — SSE: the status panels re-rendered every tick

const OPS_STREAM_MS = 2000;

@Controller()
export class OpsController {
  constructor(
    private readonly cfg: ConfigService,
    private readonly mm: MmPortfolioTrader,
    @Optional() private readonly db?: DbService,
    // Global telemetry seam (TelemetryModule is @Global, exports both). @Optional so
    // the offline UiModule DI-compile test — which doesn't import TelemetryModule —
    // still resolves; in the running app they're always present.
    @Optional() @Inject(TELEMETRY) private readonly telemetry?: ITelemetry,
    @Optional() private readonly registry?: PrometheusRegistry,
  ) {}

  @Get('ops')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(): Promise<string> {
    return renderOpsPage(await this.buildState());
  }

  @Sse('ops/stream')
  stream(): Observable<MessageEvent> {
    return interval(OPS_STREAM_MS).pipe(
      startWith(0),
      switchMap(() => from(this.buildState())),
      map((state) => ({ data: { html: renderOpsLive(state).value } }) as MessageEvent),
    );
  }

  /** Gather the live operator state — mirrors HealthController.ready()'s input assembly. */
  private async buildState(): Promise<OpsState> {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const persistEnabled = app.marketMaking.persist;
    const dbReachable = persistEnabled ? (this.db ? await this.db.ping() : false) : null;

    const snap = this.mm.snapshot();
    const lastTick = this.mm.lastTickAt();
    const nowMs = Date.now();
    const lastTickAgeMs = lastTick === null ? null : nowMs - lastTick;
    const bookBarAgesMs = snap.books
      .filter((b) => b.running && b.lastBarAt)
      .map((b) => nowMs - new Date(b.lastBarAt as string).getTime());

    const readiness = assessReadiness({
      persistEnabled,
      dbReachable,
      deskRunning: snap.running,
      bookCount: snap.bookCount,
      lastTickAgeMs,
      pollIntervalMs: this.mm.getPollIntervalMs(),
      readyTickMultiplier: app.telemetry.readyTickMultiplier,
      bookBarAgesMs,
      feedStalenessMs: app.telemetry.feedStalenessMs,
    });

    return { uptimeSeconds: process.uptime(), readiness, persistEnabled, dbReachable, mm: snap, lastTickAgeMs, telemetry: this.buildTelemetry() };
  }

  /** Runtime/telemetry summary — process memory + live loop counters read from the
   *  Prometheus registry (the metrics ledger). Counters are live-incremented at their
   *  instrumentation points, so no scrape/collect is needed to read them here. */
  private buildTelemetry(): OpsTelemetry {
    const mem = process.memoryUsage();
    const reg = this.registry;
    const tickHist = reg?.histogram(M.tickDuration)?.snapshot({ loop: 'mm' });
    return {
      enabled: this.telemetry?.enabled ?? false,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      eventLoopLagSec: reg?.gauge(M.eventLoopLag)?.value() ?? null,
      ticks: reg?.counter(M.tick)?.value({ loop: 'mm' }) ?? 0,
      tickOverruns: reg?.counter(M.tickOverrun)?.value({ loop: 'mm' }) ?? 0,
      meanTickMs: tickHist && tickHist.count > 0 ? (tickHist.sum / tickHist.count) * 1000 : null,
      persistOk: reg?.counter(M.persistCheckpoints)?.value({ result: 'ok' }) ?? 0,
      persistErrors: reg?.counter(M.persistCheckpoints)?.value({ result: 'error' }) ?? 0,
    };
  }
}
