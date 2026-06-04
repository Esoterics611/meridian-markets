import { Body, Controller, Get, Inject, Optional, Post, Query } from '@nestjs/common';
import { MmPortfolioTrader } from './live/mm-portfolio-trader';
import { MmScreener } from './screen/mm-screener';
import { mmStrategyRegistry } from './registry/mm-strategy-registry';
import { listMmPresets, getMmPreset } from './markets/mm-market-presets';
import { MmNavRepository, MmNavRow } from './persistence/mm-nav.repository';
import { DeskEventLog } from './events/desk-event-log';

// Control plane for the automated market-making books. Mirrors the stat-arb
// LiveController's portfolio shape so the desk drives both the same way — launch
// a quoter on an instrument, start/stop the loop, flatten, read the book.
//
//   GET  /api/market-making/strategies  — deployable quoter catalogue
//   GET  /api/market-making/markets      — MM market presets (stablecoin/FX/...)
//   POST /api/market-making/launch       — run a quoter on one instrument
//   POST /api/market-making/remove       — flatten + drop one book
//   POST /api/market-making/start|stop|tick
//   POST /api/market-making/flatten      — flatten every book
//   GET  /api/market-making/snapshot     — desk + per-book quotes/inventory/PnL
//   GET  /api/market-making/nav          — durable desk/per-book equity curve (P3)
//   GET  /api/market-making/events       — live business-event tape (fills/verdict/lifecycle)

const USDC = 1_000_000n;
const DEFAULT_NAV_HOURS = 24;
const MAX_NAV_HOURS = 24 * 365; // a year of curve — generous cap, bounds the scan
const DEFAULT_EVENTS_LIMIT = 200;
const MAX_EVENTS_LIMIT = 2000;

@Controller('api/market-making')
export class MmController {
  constructor(
    private readonly portfolio: MmPortfolioTrader,
    private readonly screener: MmScreener,
    // Durable NAV history (Telemetry P3). Null when MM_PERSIST is off / no DB ⇒ the
    // endpoint returns an empty curve with a note. @Optional so the isolated
    // controller spec (no DB) and a bare `new MmController(...)` both resolve.
    @Optional() @Inject(MmNavRepository) private readonly navRepo: MmNavRepository | null = null,
    // Live business-event tape. @Optional so a bare `new MmController(...)` resolves;
    // the module always provides the shared DeskEventLog.
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
  ) {}

  /**
   * Spread-capture screener: rank instruments by expected MM profit/day
   * (spread + rebate − adverse, weighted by fillability). "Where should we quote?"
   *   GET /api/market-making/screen            — all presets
   *   GET /api/market-making/screen?preset=ID  — one preset
   */
  @Get('screen')
  async screen(@Query('preset') preset?: string) {
    const filter = preset && preset !== 'all' ? [preset] : undefined;
    return this.screener.screen(filter);
  }

  @Get('strategies')
  strategies() {
    return {
      strategies: mmStrategyRegistry.liveCapable().map((d) => ({
        id: d.id,
        family: d.family,
        label: d.label,
        description: d.description,
        courseRef: d.courseRef,
        defaultParams: d.defaultParams,
      })),
    };
  }

  @Get('markets')
  markets() {
    return { presets: listMmPresets() };
  }

  /**
   * Launch ONE market-making book on an instrument and ensure the loop runs.
   *   { symbol, strategyId?, params?, capitalUsdc? | startingCapitalUnits? }
   * Re-launching the same symbol replaces its book.
   */
  @Post('launch')
  async launch(
    @Body()
    body: {
      symbol?: string;
      strategyId?: string;
      params?: Record<string, number>;
      capitalUsdc?: number;
      startingCapitalUnits?: string;
      source?: string;
      /** Quote size in $ notional (sized ÷ price); omit to use the fixed config size. */
      quoteNotionalUsd?: number;
    },
  ) {
    if (!body.symbol) return { error: 'symbol is required to launch a market-making book' };
    if (body.strategyId && !mmStrategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: mmStrategyRegistry.liveCapable().map((d) => d.id) };
    }
    const capital =
      body.startingCapitalUnits !== undefined
        ? BigInt(body.startingCapitalUnits)
        : BigInt(Math.round(body.capitalUsdc ?? 100_000)) * USDC;
    try {
      await this.portfolio.addBook(
        { symbol: body.symbol, strategyId: body.strategyId, params: body.params, source: body.source, quoteNotionalUsd: body.quoteNotionalUsd },
        capital,
      );
    } catch (err) {
      return { error: (err as Error).message };
    }
    this.portfolio.start();
    return this.portfolio.snapshot();
  }

  /**
   * Launch every instrument in a preset as its own book.
   *   { presetId, strategyId?, capitalUsdcPerBook? }
   */
  @Post('launch-preset')
  async launchPreset(@Body() body: { presetId?: string; strategyId?: string; capitalUsdcPerBook?: number; quoteNotionalUsd?: number }) {
    if (!body.presetId) return { error: 'presetId is required' };
    const preset = getMmPreset(body.presetId);
    if (!preset) return { error: `unknown presetId: ${body.presetId}`, known: listMmPresets().map((p) => p.id) };
    if (body.strategyId && !mmStrategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: mmStrategyRegistry.liveCapable().map((d) => d.id) };
    }
    const capital = BigInt(Math.round(body.capitalUsdcPerBook ?? 100_000)) * USDC;
    // Notional sizing matters most here: hl-perps / DEX presets span a $66k perp and
    // a $1 stable, which a single fixed unit count cannot size sanely.
    for (const symbol of preset.symbols) {
      await this.portfolio
        .addBook({ symbol, strategyId: body.strategyId, source: preset.source, quoteNotionalUsd: body.quoteNotionalUsd }, capital)
        .catch(() => undefined);
    }
    this.portfolio.start();
    return this.portfolio.snapshot();
  }

  @Post('remove')
  async remove(@Body() body: { symbol?: string }) {
    if (!body.symbol) return { error: 'symbol required' };
    const removed = await this.portfolio.removeBook(body.symbol);
    return { removed, ...this.portfolio.snapshot() };
  }

  @Post('start')
  start() {
    this.portfolio.start();
    return this.portfolio.snapshot();
  }

  @Post('stop')
  stop() {
    this.portfolio.stop();
    return this.portfolio.snapshot();
  }

  @Post('tick')
  async tick() {
    await this.portfolio.tick();
    return this.portfolio.snapshot();
  }

  @Post('flatten')
  async flatten() {
    await this.portfolio.flattenAll();
    return this.portfolio.snapshot();
  }

  @Get('snapshot')
  snapshot() {
    return this.portfolio.snapshot();
  }

  /**
   * Durable NAV / equity-curve history (Telemetry P3) — the multi-day track record,
   * read from the append-only mm_nav table. Oldest-first (chart order).
   *   GET /api/market-making/nav?hours=24            — the desk-aggregate NAV curve
   *   GET /api/market-making/nav?hours=72&book=BTC   — one book's equity curve
   * Returns an empty curve + a note when MM_PERSIST is off (no durable NAV without
   * Postgres). bigints are serialised to decimal strings, like every MM read.
   */
  @Get('nav')
  async nav(@Query('hours') hours?: string, @Query('book') book?: string) {
    const bookKey = book ?? '';
    if (!this.navRepo) {
      return { enabled: false, book: bookKey, points: [], note: 'durable NAV is off — set MM_PERSIST=true (needs Postgres + migrations)' };
    }
    const h = clampNavHours(hours);
    const fromAsOf = new Date(Date.now() - h * 3_600_000);
    const rows = await this.navRepo.navHistory(fromAsOf, bookKey);
    return { enabled: true, book: bookKey, hours: h, points: rows.map(serializeNavRow) };
  }

  /**
   * Live business-event tape — every trade enter/exit, risk-verdict change, and
   * book lifecycle event, newest-last (feed order). The /demo activity feed
   * long-polls this with `?since=<lastSeq>`; `cursor` in the response is the seq
   * to pass next time (never miss or double-count an event).
   *   GET /api/market-making/events                 — recent events (default 200)
   *   GET /api/market-making/events?since=128        — only events after seq 128
   *   GET /api/market-making/events?book=BTC&limit=50
   */
  @Get('events')
  events(@Query('since') since?: string, @Query('limit') limit?: string, @Query('book') book?: string) {
    if (!this.eventLog) return { events: [], cursor: 0 };
    const sinceSeq = Number.isFinite(Number(since)) && since !== undefined && since !== '' ? Number(since) : undefined;
    const events = this.eventLog.recent({ sinceSeq, limit: clampEventsLimit(limit), book: book || undefined });
    return { events, cursor: this.eventLog.lastSeq() };
  }
}

/** Parse + clamp the events `limit` query param. */
function clampEventsLimit(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVENTS_LIMIT;
  return Math.min(Math.floor(n), MAX_EVENTS_LIMIT);
}

/** Parse + clamp the `hours` query param to a sane, bounded window. */
function clampNavHours(raw?: string): number {
  const h = Number(raw);
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_NAV_HOURS;
  return Math.min(h, MAX_NAV_HOURS);
}

/** Map a NAV row to a JSON-safe shape (bigints → decimal strings). */
function serializeNavRow(r: MmNavRow) {
  return {
    asOf: r.asOf.toISOString(),
    bookKey: r.bookKey,
    equityUnits: r.equityUnits.toString(),
    netPnlUnits: r.netPnlUnits.toString(),
    realisedPnlUnits: r.realisedPnlUnits.toString(),
    unrealisedPnlUnits: r.unrealisedPnlUnits.toString(),
    feesUnits: r.feesUnits.toString(),
    fundingUnits: r.fundingUnits.toString(),
    inventoryUnits: r.inventoryUnits.toString(),
    maxDrawdownPct: r.maxDrawdownPct,
  };
}
