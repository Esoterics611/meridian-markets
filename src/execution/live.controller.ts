import { Body, Controller, Get, Post } from '@nestjs/common';
import { LivePaperTrader } from './live-paper-trader';
import { LivePortfolioTrader, PortfolioPair } from './live-portfolio-trader';
import { strategyRegistry } from '../stat-arb/strategies/strategy-registry';

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
  ) {}

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
      this.trader.reconfigure({ symbolA: body.symbolA, symbolB: body.symbolB, beta: body.beta, strategyId: body.strategyId });
    } else if (body.strategyId) {
      // Strategy-only switch: re-arm the current pair with the new strategy.
      const s = this.trader.snapshot();
      this.trader.reconfigure({ symbolA: s.symbolA, symbolB: s.symbolB, beta: s.beta, strategyId: body.strategyId });
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
