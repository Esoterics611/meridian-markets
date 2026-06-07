import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MmPortfolioTrader } from './mm-portfolio-trader';

// FundingRefreshCron — keeps each live MM book's perp funding rate current.
//
// Funding is the 5th P&L line (the inventory carry, MM course §8.10): the rate a
// perp book pays/earns on whatever inventory it holds. The book is given a funding
// rate ONCE at launch (market-making.module fetches it), but funding drifts hourly
// (HL settles on the hour), so over a multi-hour run the static rate goes stale —
// the carry accrual then diverges from reality. This cron re-reads each HL book's
// live rate on an interval and pushes it into the book (trader.refreshFunding →
// mm-book.setFundingRatePerHour), so the carry stays honest over an 8h session.
//
// `fundingRateFor` is the SAME function market-making.module uses at launch (HL →
// currentFunding().lastFundingRate, everything else → 0), injected so the source
// is shared (one funding client) and the cron is unit-tested with a fake. It is a
// strict no-op when the cadence is 0 or in test (the spec drives tick() directly),
// and never throws — a refresh failure leaves the last known rate in place.

export type FundingRateFor = (symbol: string, source: string | undefined) => Promise<number | null>;

@Injectable()
export class FundingRefreshCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FundingRefreshCron.name);
  private handle: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly trader: MmPortfolioTrader,
    private readonly rateFor: FundingRateFor,
  ) {}

  onModuleInit(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive tick() explicitly
    const intervalMs = app.marketMaking.fundingRefreshMs;
    if (!intervalMs || intervalMs <= 0) return; // refresh disabled
    this.handle = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`mm funding refresh started: every ${intervalMs}ms (perp books re-read live funding)`);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  /** One interval: refresh every perp book's funding rate. Never throws. */
  async tick(): Promise<void> {
    try {
      const updated = await this.trader.refreshFunding(this.rateFor);
      if (updated > 0) this.logger.log(`mm funding refreshed on ${updated} book(s)`);
    } catch (err) {
      this.logger.error(`mm funding refresh tick failed: ${(err as Error).message}`);
    }
  }
}
