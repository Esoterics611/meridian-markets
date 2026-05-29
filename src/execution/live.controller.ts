import { Controller, Get, Post } from '@nestjs/common';
import { LivePaperTrader } from './live-paper-trader';

// Control plane for the live paper-trading loop. The loop itself runs in the
// background (setInterval); these endpoints start/stop it and read its book.
// Designed to be driven from a terminal (curl / a TUI) — the web dashboard is
// just one consumer of GET /snapshot.
//
//   POST /api/stat-arb/live/start    — arm the loop
//   POST /api/stat-arb/live/stop     — halt the loop
//   POST /api/stat-arb/live/tick     — single-step one iteration (manual/debug)
//   GET  /api/stat-arb/live/snapshot — current book: regime, z, PnL, positions

@Controller('api/stat-arb/live')
export class LiveController {
  constructor(private readonly trader: LivePaperTrader) {}

  @Post('start')
  start() {
    this.trader.start();
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
