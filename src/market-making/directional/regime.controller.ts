import { Body, Controller, Get, Inject, Optional, Post } from '@nestjs/common';
import { RegimeDeskTrader } from './regime-desk-trader';

// /api/regime/* — the control plane for the standalone "take sides" Regime Desk cockpit
// (Playbook II P13), mirroring MmController's shape. INERT by default: when REGIME_DESK is off the
// trader provider is absent (null), so every endpoint returns { enabled: false } and nothing about
// the existing desk changes. Regime + fill events already flow on /api/market-making/events.
//
//   GET  /api/regime/snapshot  — weather + position cards (+ stop gauge) + risk/exposure + TCA
//   POST /api/regime/flatten   — { symbol } flatten one book
//   POST /api/regime/halt      — desk kill-switch

@Controller('api/regime')
export class RegimeController {
  constructor(@Optional() @Inject(RegimeDeskTrader) private readonly trader: RegimeDeskTrader | null = null) {}

  @Get('snapshot')
  snapshot() {
    if (!this.trader) return { enabled: false, note: 'Regime Desk is off — launch with REGIME_DESK=true to host it in-process.' };
    return { enabled: true, ...this.trader.snapshot() };
  }

  @Post('flatten')
  flatten(@Body() body: { symbol?: string }) {
    if (!this.trader) return { enabled: false };
    const symbol = (body?.symbol ?? '').trim();
    if (!symbol) return { enabled: true, ok: false, error: 'symbol required' };
    return { enabled: true, ok: this.trader.flatten(symbol), symbol: symbol.toUpperCase() };
  }

  @Post('halt')
  halt() {
    if (!this.trader) return { enabled: false };
    this.trader.halt();
    return { enabled: true, ok: true, halted: true };
  }
}
