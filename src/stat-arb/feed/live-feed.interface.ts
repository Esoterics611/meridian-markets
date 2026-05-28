import { Bar } from '../backtest/bar';

// IBarFeed is the streaming-feed seam for the stat-arb engine. Same pattern
// as ITradingVenue and IYieldProvider: consumers depend on this interface
// only; the concrete implementation (MockBarFeed for the demo, CcxtBarFeed
// dormant) is selected once in StatArbModule's factory based on
// MOCK_TRADING_ENABLED (we share the existing mock-default flag rather than
// introducing a second one).

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
    super(`${feed} bar feed is not configured — populate KYB-gated secrets and set MOCK_TRADING_ENABLED=false`);
    this.name = 'BarFeedNotConfiguredError';
  }
}
