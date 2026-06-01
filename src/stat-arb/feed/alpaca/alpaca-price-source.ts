import { IPriceSource, toMicros } from '../price-source';
import { AlpacaDataClient } from './alpaca-data-client';

// Fill-price source for PaperVenue when trading equities. Pegs each simulated
// fill to Alpaca's latest RAW trade price (what live execution actually pays —
// orders fill at raw, not split/dividend-adjusted, prices). Returns 6-decimal
// micros to match the venue boundary, exactly like BinancePriceSource.

export class AlpacaPriceSource implements IPriceSource {
  constructor(private readonly client: AlpacaDataClient) {}

  async priceMicros(symbol: string): Promise<bigint> {
    return toMicros(await this.client.latestTrade(symbol));
  }
}
