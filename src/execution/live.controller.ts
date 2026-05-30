import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { LivePaperTrader } from './live-paper-trader';
import { LivePortfolioTrader, PortfolioPair } from './live-portfolio-trader';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { strategyRegistry } from '../stat-arb/strategies/strategy-registry';

/**
 * Venue id closed trades persist under, per execution mode:
 *   paper/canary -> PaperVenue ('paper'), live -> RealBinanceVenue ('binance'),
 *   mock -> MockTradingVenue ('mock'). The blotter defaults to this so the UI
 *   shows the trades the active loop is actually writing.
 */
function venueForMode(mode: string | undefined): string {
  switch (mode) {
    case 'live':
      return 'binance';
    case 'paper':
    case 'canary':
      return 'paper';
    default:
      return 'mock';
  }
}

// Control plane for the live paper-trading loop. The loop itself runs in the
// background (setInterval); these endpoints start/stop it and read its book.
// Designed to be driven from a terminal (curl / a TUI) — the web dashboard is
// just one consumer of GET /snapshot.
//
//   POST /api/stat-arb/live/start     — arm the loop
//   POST /api/stat-arb/live/stop      — halt the loop
//   POST /api/stat-arb/live/tick      — single-step one iteration (manual/debug)
//   POST /api/stat-arb/live/configure — repoint at a pair (+ optional β) and/or set capital
//   GET  /api/stat-arb/live/snapshot  — current book: regime, z, PnL, positions

const USDC = 1_000_000n;

@Controller('api/stat-arb/live')
export class LiveController {
  constructor(
    private readonly trader: LivePaperTrader,
    private readonly portfolio: LivePortfolioTrader,
    private readonly repo: StatArbRepository,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Persisted trade blotter — closed round-trips written to stat_arb_trades by
   * the live loop. Survives restart and spans every book on the venue, unlike
   * the in-memory `recentTrades` on the live snapshot. Defaults `venue` to the
   * one the active EXECUTION_MODE writes under.
   *
   *   GET /api/stat-arb/live/trades?venue=paper&limit=50
   */
  @Get('trades')
  async trades(@Query('venue') venue?: string, @Query('limit') limit?: string) {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const v = venue ?? venueForMode(app.execution?.mode);
    const lim = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 500);
    const rows = await this.repo.recentTrades(v, lim);
    return {
      venue: v,
      count: rows.length,
      trades: rows.map((t) => ({
        id: t.id,
        pair: `${t.symbolA}/${t.symbolB}`,
        symbolA: t.symbolA,
        symbolB: t.symbolB,
        side: t.side,
        entryZ: t.entryZ,
        exitZ: t.exitZ,
        notionalUnits: t.notionalUnits.toString(),
        pnlUnits: t.pnlUnits.toString(),
        feesUnits: t.feesUnits.toString(),
        openedAt: t.openedAt.toISOString(),
        closedAt: t.closedAt.toISOString(),
      })),
    };
  }

  @Post('start')
  start() {
    this.trader.start();
    return this.trader.snapshot();
  }

  /**
   * Repoint the loop at a different pair (switching presaved markets on live
   * data) and/or set the starting capital. All fields optional:
   *   { symbolA, symbolB, beta }         — switch pair (β from discovery)
   *   { startingCapitalUnits }           — set capital in 6-decimal USDC units
   *   { startingCapitalUsdc }            — set capital in whole USDC (convenience)
   * Halts the loop; caller re-arms with /start.
   */
  @Post('configure')
  configure(
    @Body()
    body: {
      symbolA?: string;
      symbolB?: string;
      beta?: number;
      strategyId?: string;
      params?: Record<string, number>;
      startingCapitalUnits?: string;
      startingCapitalUsdc?: number;
    },
  ) {
    if (body.strategyId && !strategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: strategyRegistry.liveCapable().map((d) => d.id) };
    }
    if (body.startingCapitalUnits !== undefined) {
      this.trader.setStartingCapital(BigInt(body.startingCapitalUnits));
    } else if (body.startingCapitalUsdc !== undefined) {
      this.trader.setStartingCapital(BigInt(Math.round(body.startingCapitalUsdc)) * USDC);
    }
    if (body.symbolA && body.symbolB) {
      this.trader.reconfigure({ symbolA: body.symbolA, symbolB: body.symbolB, beta: body.beta, strategyId: body.strategyId, params: body.params });
    } else if (body.strategyId) {
      // Strategy-only switch: re-arm the current pair with the new strategy.
      const s = this.trader.snapshot();
      this.trader.reconfigure({ symbolA: s.symbolA, symbolB: s.symbolB, beta: s.beta, strategyId: body.strategyId, params: body.params });
    }
    return this.trader.snapshot();
  }

  /** The desk's deployable strategy menu (live-capable catalogue entries). */
  @Get('strategies')
  strategies() {
    return {
      strategies: strategyRegistry.liveCapable().map((d) => ({
        id: d.id,
        family: d.family,
        label: d.label,
        description: d.description,
        courseRef: d.courseRef,
        riskProfile: d.defaultRiskProfile,
        defaultParams: d.defaultParams,
      })),
    };
  }

  @Post('stop')
  stop() {
    this.trader.stop();
    return this.trader.snapshot();
  }

  /** Desk-wide kill switch: halt the single book AND every portfolio book. */
  @Post('kill')
  kill() {
    this.trader.stop();
    this.portfolio.stop();
    return { halted: true, single: this.trader.isRunning(), portfolio: this.portfolio.isRunning() };
  }

  @Post('tick')
  async tick() {
    await this.trader.tick();
    return this.trader.snapshot();
  }

  @Get('snapshot')
  snapshot() {
    return this.trader.snapshot();
  }

  // --- Multi-currency portfolio: N pairs trading concurrently on live data ---

  /**
   * Set the active multi-currency book. Body:
   *   { pairs: [{symbolA, symbolB, beta?}], capitalUsdc?, startingCapitalUnits? }
   * Capital is split evenly across the pairs. Halts the loop; re-arm with
   * POST /portfolio/start.
   */
  @Post('portfolio')
  setPortfolio(
    @Body() body: { pairs?: PortfolioPair[]; capitalUsdc?: number; startingCapitalUnits?: string; strategyId?: string },
  ) {
    if (body.strategyId && !strategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: strategyRegistry.liveCapable().map((d) => d.id) };
    }
    const pairs = (body.pairs ?? [])
      .filter((p) => p && p.symbolA && p.symbolB)
      .map((p) => ({ ...p, strategyId: p.strategyId ?? body.strategyId }));
    const capital =
      body.startingCapitalUnits !== undefined
        ? BigInt(body.startingCapitalUnits)
        : body.capitalUsdc !== undefined
          ? BigInt(Math.round(body.capitalUsdc)) * USDC
          : undefined;
    this.portfolio.setPairs(pairs, capital);
    return this.portfolio.snapshot();
  }

  /**
   * Launch ONE station additively — the human "launch a strategy on a market"
   * action from the UI cockpit. Unlike POST /portfolio (which replaces the whole
   * set and even-splits capital), this appends a single isolated book with its
   * own capital + param overrides and leaves existing books untouched, then
   * ensures the loop is running. Re-launching the same pair replaces it.
   *   { symbolA, symbolB, beta?, strategyId?, params?, capitalUsdc? | startingCapitalUnits? }
   */
  @Post('portfolio/launch')
  launch(
    @Body()
    body: {
      symbolA?: string;
      symbolB?: string;
      beta?: number;
      strategyId?: string;
      params?: Record<string, number>;
      capitalUsdc?: number;
      startingCapitalUnits?: string;
    },
  ) {
    if (!body.symbolA || !body.symbolB) return { error: 'symbolA and symbolB are required to launch a station' };
    if (body.strategyId && !strategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: strategyRegistry.liveCapable().map((d) => d.id) };
    }
    const capital =
      body.startingCapitalUnits !== undefined
        ? BigInt(body.startingCapitalUnits)
        : BigInt(Math.round(body.capitalUsdc ?? 100_000)) * USDC;
    try {
      this.portfolio.addBook(
        { symbolA: body.symbolA, symbolB: body.symbolB, beta: body.beta, strategyId: body.strategyId, params: body.params },
        capital,
      );
    } catch (err) {
      return { error: (err as Error).message };
    }
    this.portfolio.start();
    return this.portfolio.snapshot();
  }

  @Post('portfolio/start')
  startPortfolio() {
    this.portfolio.start();
    return this.portfolio.snapshot();
  }

  @Post('portfolio/stop')
  stopPortfolio() {
    this.portfolio.stop();
    return this.portfolio.snapshot();
  }

  @Post('portfolio/tick')
  async tickPortfolio() {
    await this.portfolio.tick();
    return this.portfolio.snapshot();
  }

  @Get('portfolio')
  portfolioSnapshot() {
    return this.portfolio.snapshot();
  }
}
