import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MmPortfolioTrader } from './live/mm-portfolio-trader';
import { MmScreener } from './screen/mm-screener';
import { mmStrategyRegistry } from './registry/mm-strategy-registry';
import { listMmPresets, getMmPreset } from './markets/mm-market-presets';

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

const USDC = 1_000_000n;

@Controller('api/market-making')
export class MmController {
  constructor(
    private readonly portfolio: MmPortfolioTrader,
    private readonly screener: MmScreener,
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
      await this.portfolio.addBook({ symbol: body.symbol, strategyId: body.strategyId, params: body.params }, capital);
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
  async launchPreset(@Body() body: { presetId?: string; strategyId?: string; capitalUsdcPerBook?: number }) {
    if (!body.presetId) return { error: 'presetId is required' };
    const preset = getMmPreset(body.presetId);
    if (!preset) return { error: `unknown presetId: ${body.presetId}`, known: listMmPresets().map((p) => p.id) };
    if (body.strategyId && !mmStrategyRegistry.has(body.strategyId)) {
      return { error: `unknown strategyId: ${body.strategyId}`, known: mmStrategyRegistry.liveCapable().map((d) => d.id) };
    }
    const capital = BigInt(Math.round(body.capitalUsdcPerBook ?? 100_000)) * USDC;
    for (const symbol of preset.symbols) {
      await this.portfolio.addBook({ symbol, strategyId: body.strategyId }, capital).catch(() => undefined);
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
}
