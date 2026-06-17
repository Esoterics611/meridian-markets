import { Inject, Injectable, Logger, Module, Optional, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { RegimeDeskTrader } from './regime-desk-trader';
import { RegimeController } from './regime.controller';
import { RegimeLiveDriver } from './regime-live-driver';

// RegimeModule — hosts the standalone "take sides" Regime Desk in-process + serves its /demo
// cockpit (Playbook II P13). INERT by default: with REGIME_DESK off, the RegimeDeskTrader provider
// resolves to null, the controller returns { enabled:false }, and no driver runs — nothing about
// existing desks changes. With REGIME_DESK=true the bootstrap gates + seats the top-N validated
// books and starts the live poll driver (real HL data).

const REGIME_ENV = {
  symbols: (process.env['REGIME_SYMBOLS'] ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,LTC,SUI,APT,ARB,OP,INJ,TIA').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  gateDays: Number(process.env['REGIME_GATE_DAYS'] ?? 90),
  interval: process.env['REGIME_INTERVAL'] ?? '1h',
  baseNotionalUsd: Number(process.env['REGIME_BASE_NOTIONAL_USD'] ?? 50_000),
  topN: Number(process.env['REGIME_TOP_N'] ?? 8),
  pollMs: Number(process.env['REGIME_POLL_MS'] ?? 60_000),
  marketSymbol: (process.env['REGIME_MARKET_SYMBOL'] ?? 'BTC').toUpperCase(),
};

/** Lifecycle owner: when the trader is present (REGIME_DESK on), gate + seat + start the poll driver. */
@Injectable()
export class RegimeBootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('RegimeDesk');
  private driver: RegimeLiveDriver | null = null;

  constructor(@Optional() @Inject(RegimeDeskTrader) private readonly trader: RegimeDeskTrader | null = null) {}

  onModuleInit(): void {
    if (!this.trader) {
      this.log.log('OFF (set REGIME_DESK=true to host the take-sides cockpit on /demo).');
      return;
    }
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
