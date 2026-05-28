import { Injectable } from '@nestjs/common';
import { Bar } from '../backtest/bar';
import { BarFeedNotConfiguredError, IBarFeed } from './live-feed.interface';

// DORMANT in Phase 3 demo. Throws BarFeedNotConfiguredError on every method
// until MOCK_TRADING_ENABLED=false AND Binance KYB completes. Same posture
// as RealBinanceVenue, RealHyperliquidHedgeVenue, RealOndoYieldProvider —
// ship the stub, leave mock-default on, refuse to fire without business
// sign-off.
//
// Wire-up plan (post-KYB):
//   nextBar(symbol) → GET https://api.binance.com/api/v3/klines?symbol=...&interval=1m&limit=1
//   Convert each kline tuple → Bar, advance an internal "lastOpenTime" cursor.

@Injectable()
export class RealCcxtBarFeed implements IBarFeed {
  readonly feedId = 'binance.spot';

  async nextBar(_symbol: string): Promise<Bar | null> {
    throw new BarFeedNotConfiguredError(this.feedId);
  }
}
