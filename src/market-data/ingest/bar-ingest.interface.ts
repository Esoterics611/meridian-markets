import { Bar } from '../../stat-arb/backtest/bar';

// IBarIngest is the batch-ingest swap seam. Same mock-default posture as
// ITradingVenue / IYieldProvider / IHedgeVenue / IBarFeed:
//   - MockBarIngest replays a fixture (CSV or inline arrays).
//   - CcxtBarIngest is dormant until configured with credentials; throws on every call.
//
// The contract: nextBatch() pulls the next batch of bars across all symbols
// the ingest was configured for. Empty batch = source exhausted (mock) or
// no new bars yet (real-time). Caller paces the loop.

export const BAR_INGEST = Symbol('BAR_INGEST');

export interface IngestedBar {
  /** Normalised symbol — see src/market-data/symbol.ts. */
  symbol: string;
  bar: Bar;
}

export interface IBarIngest {
  /** Stable identifier (e.g. "mock", "binance.spot"). */
  readonly ingestId: string;

  /** Pull the next batch of bars. Empty array = nothing new. */
  nextBatch(): Promise<IngestedBar[]>;
}

export class BarIngestNotConfiguredError extends Error {
  constructor(ingest: string) {
    super(
      `${ingest} bar ingest is not configured — populate the required secrets and set MOCK_TRADING_ENABLED=false`,
    );
    this.name = 'BarIngestNotConfiguredError';
  }
}
