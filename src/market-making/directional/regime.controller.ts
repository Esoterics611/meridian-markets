import { Body, Controller, Get, Inject, Optional, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { RegimeDeskTrader } from './regime-desk-trader';

// /api/regime/* — the control plane for the standalone "take sides" Regime Desk cockpit
// (Playbook II P13), mirroring MmController's shape. INERT by default: when REGIME_DESK is off the
// trader provider is absent (null), so every endpoint returns { enabled: false } and nothing about
// the existing desk changes. Regime + fill events already flow on /api/market-making/events.
//
// `driving` reflects the two-flag split (regime.module.ts): the cockpit is SERVED with REGIME_DESK,
// but the in-process trading driver only runs with REGIME_DESK_DRIVE. Serve-only ⇒ driving:false and
// the snapshot is an empty (un-driven) desk — the real desk runs in scripts/regime-book-live.ts.
//
//   GET  /api/regime/snapshot  — weather + position cards (+ stop gauge) + risk/exposure + TCA
//   POST /api/regime/flatten   — { symbol } flatten one book
//   POST /api/regime/halt      — desk kill-switch

@Controller('api/regime')
export class RegimeController {
  constructor(
    @Optional() @Inject(RegimeDeskTrader) private readonly trader: RegimeDeskTrader | null = null,
    @Optional() private readonly config: ConfigService<AppConfig> | null = null,
  ) {}

  private driving(): boolean {
    return this.config?.get('marketMaking', { infer: true })?.regimeDeskDrive ?? false;
  }

  @Get('snapshot')
  snapshot() {
    if (!this.trader) return { enabled: false, note: 'Regime Desk is off — launch with REGIME_DESK=true to serve the cockpit on /demo.' };
    const driving = this.driving();
    const note = driving
      ? undefined
      : 'SERVE-ONLY: the in-process driver is off (REGIME_DESK_DRIVE unset). Run the desk via scripts/regime-book-live.ts (terminal cockpit) — this view stays empty by design.';
    return { enabled: true, driving, note, ...this.trader.snapshot() };
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
