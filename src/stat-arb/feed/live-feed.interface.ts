import { Bar } from '../backtest/bar';

// IBarFeed is the streaming-feed seam for the stat-arb engine. Consumers depend
// on this interface only; the concrete implementation is selected in
// StatArbModule's factory by FEED_SOURCE:
//   FEED_SOURCE=binance -> BinancePublicBarFeed (real public market data)
//   FEED_SOURCE=mock    -> MockBarFeed (synthetic generator for offline dev)

export const LIVE_FEED = Symbol('LIVE_FEED');

export interface IBarFeed {
  /** Stable feed identifier (e.g. "mock", "binance.spot"). */
  readonly feedId: string;
  /**
   * Pull the next bar for a symbol. Returns null when the feed is exhausted
   * (synthetic fixtures) or when there is no new bar yet (real-time).
   * The contract is one bar per call; the caller paces the loop.
   */
  nextBar(symbol: string): Promise<Bar | null>;
}

export class BarFeedNotConfiguredError extends Error {
  constructor(feed: string) {
    super(`${feed} bar feed is not configured — set FEED_SOURCE and any required base URL`);
    this.name = 'BarFeedNotConfiguredError';
  }
}
