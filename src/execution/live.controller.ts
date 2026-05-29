import { Body, Controller, Get, Post } from '@nestjs/common';
import { LivePaperTrader } from './live-paper-trader';

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
  constructor(private readonly trader: LivePaperTrader) {}

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
      startingCapitalUnits?: string;
      startingCapitalUsdc?: number;
    },
  ) {
    if (body.startingCapitalUnits !== undefined) {
      this.trader.setStartingCapital(BigInt(body.startingCapitalUnits));
    } else if (body.startingCapitalUsdc !== undefined) {
      this.trader.setStartingCapital(BigInt(Math.round(body.startingCapitalUsdc)) * USDC);
    }
    if (body.symbolA && body.symbolB) {
      this.trader.reconfigure({ symbolA: body.symbolA, symbolB: body.symbolB, beta: body.beta });
    }
    return this.trader.snapshot();
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
}
