import { Inject, Injectable, Logger, Module, Optional, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { RegimeDeskTrader } from './regime-desk-trader';
import { RegimeController } from './regime.controller';
import { RegimeLiveDriver } from './regime-live-driver';

// RegimeModule — serves the standalone "take sides" Regime Desk cockpit/control-plane on /demo
// (Playbook II P13). INERT by default: with REGIME_DESK off, the RegimeDeskTrader provider resolves
// to null, the controller returns { enabled:false }, and no driver runs — nothing about existing
// desks changes.
//
// Two-flag split (so the UI backend never competes with the desk scripts):
//   REGIME_DESK=true        → SERVE the cockpit/control-plane only (read-only; no HL polling).
//   REGIME_DESK_DRIVE=true  → ALSO run the in-process trading driver (the OOS gate + HL poll loop +
//                             in-memory trading). OFF by default.
// The desk is meant to be RUN by scripts/regime-book-live.ts (the self-contained terminal cockpit);
// the backend only serves the UI. Running the in-process driver AND the script at once would mean
// two regime desks double-polling HL and competing for the event loop — exactly the interference
// this split removes. Flip REGIME_DESK_DRIVE only for the all-in-one web cockpit, and then don't
// also run the script.

const REGIME_ENV = {
  symbols: (process.env['REGIME_SYMBOLS'] ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,LTC,SUI,APT,ARB,OP,INJ,TIA').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  gateDays: Number(process.env['REGIME_GATE_DAYS'] ?? 90),
  interval: process.env['REGIME_INTERVAL'] ?? '1h',
  baseNotionalUsd: Number(process.env['REGIME_BASE_NOTIONAL_USD'] ?? 50_000),
  topN: Number(process.env['REGIME_TOP_N'] ?? 8),
  pollMs: Number(process.env['REGIME_POLL_MS'] ?? 60_000),
  marketSymbol: (process.env['REGIME_MARKET_SYMBOL'] ?? 'BTC').toUpperCase(),
};

/**
 * Lifecycle owner. The in-process trading DRIVER runs ONLY when both the trader is present
 * (REGIME_DESK on) AND REGIME_DESK_DRIVE is on. Serving the cockpit alone (REGIME_DESK on,
 * drive off) starts NO driver — no HL polling, no boot-time gate — so the backend never
 * competes with the standalone scripts/regime-book-live.ts runner.
 */
@Injectable()
export class RegimeBootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('RegimeDesk');
  private driver: RegimeLiveDriver | null = null;
  /** True iff the in-process trading driver is running (exposed for the controller + tests). */
  driving = false;

  constructor(
    private readonly config: ConfigService<AppConfig>,
    @Optional() @Inject(RegimeDeskTrader) private readonly trader: RegimeDeskTrader | null = null,
  ) {}

  onModuleInit(): void {
    if (!this.trader) {
      this.log.log('OFF (set REGIME_DESK=true to serve the take-sides cockpit on /demo).');
      return;
    }
    const drive = this.config.get('marketMaking', { infer: true })?.regimeDeskDrive ?? false;
    if (!drive) {
      this.log.log(
        'SERVE-ONLY: cockpit + control plane hosted on /demo, but the in-process driver is OFF. ' +
          'Run the desk via scripts/regime-book-live.ts (terminal cockpit), or set REGIME_DESK_DRIVE=true ' +
          'to also drive it in-process. No HL polling here — it will not interfere with the desk scripts.',
      );
      return;
    }
    this.driving = true;
    this.driver = new RegimeLiveDriver(this.trader, REGIME_ENV);
    // fire-and-forget: gate + seat + poll. Guarded internally so a network miss never crashes boot.
    void this.driver.start();
  }

  onApplicationShutdown(): void {
    this.driver?.stop();
  }
}

@Module({
  controllers: [RegimeController],
  providers: [
    {
      provide: RegimeDeskTrader,
      useFactory: (config: ConfigService<AppConfig>): RegimeDeskTrader | null => {
        const mm = config.get('marketMaking', { infer: true });
        if (!mm?.regimeDeskEnabled) return null; // inert default
        const capitalUsd = REGIME_ENV.baseNotionalUsd * REGIME_ENV.topN;
        return new RegimeDeskTrader({
          deskRisk: {
            maxGrossUsd: REGIME_ENV.baseNotionalUsd * REGIME_ENV.topN,
            maxNetUsd: REGIME_ENV.baseNotionalUsd * Math.ceil(REGIME_ENV.topN / 2),
            dailyLossLimitUsd: capitalUsd * 0.015,
            capitalUsd,
            maxDrawdownFrac: 0.02,
          },
          marketSymbol: REGIME_ENV.marketSymbol,
        });
      },
      inject: [ConfigService],
    },
    RegimeBootstrap,
  ],
})
export class RegimeModule {}
