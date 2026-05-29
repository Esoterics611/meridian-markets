import { Injectable } from '@nestjs/common';
import { BarIngestNotConfiguredError, IBarIngest, IngestedBar } from './bar-ingest.interface';

// DORMANT in Phase 3. Throws BarIngestNotConfiguredError on every call until
// MOCK_TRADING_ENABLED=false AND CCXT credentials are populated. Same
// posture as RealBinanceVenue, RealCcxtBarFeed, RealOndoYieldProvider.
//
// Wire-up plan (when credentials are provisioned):
//   nextBatch() → CCXT `fetchOHLCV` per configured symbol, normalise the
//   tuple to Bar, advance per-symbol "since" cursors stored in-memory.

@Injectable()
export class CcxtBarIngest implements IBarIngest {
  readonly ingestId = 'binance.spot';

  async nextBatch(): Promise<IngestedBar[]> {
    throw new BarIngestNotConfiguredError(this.ingestId);
  }
}
