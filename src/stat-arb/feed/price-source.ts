import { BinancePublicClient } from './binance-public-client';

// IPriceSource is the fill-price seam for PaperVenue. The paper matching engine
// pegs each simulated fill to a real-time price rather than a deterministic
// mock, so paper PnL tracks actual market behaviour. Prices are returned in
// 6-decimal micros to match the venue boundary (1.0 USDT = 1_000_000 micros).

export const PRICE_SOURCE = Symbol('PRICE_SOURCE');

export interface IPriceSource {
  priceMicros(symbol: string): Promise<bigint>;
}

const MICROS = 1_000_000;

export function toMicros(price: number): bigint {
  return BigInt(Math.round(price * MICROS));
}

/** Real prices from Binance public ticker. */
export class BinancePriceSource implements IPriceSource {
  constructor(private readonly client: BinancePublicClient) {}

  async priceMicros(symbol: string): Promise<bigint> {
    return toMicros(await this.client.lastPrice(symbol));
  }
}

/**
 * Deterministic price source for mock mode and specs. Either a fixed map or a
 * caller-supplied function (e.g. read the latest mock-feed close).
 */
export class StaticPriceSource implements IPriceSource {
  constructor(private readonly resolve: (symbol: string) => number) {}

  static fromMap(prices: Record<string, number>): StaticPriceSource {
    return new StaticPriceSource((s) => prices[s] ?? 1);
  }

  async priceMicros(symbol: string): Promise<bigint> {
    return toMicros(this.resolve(symbol));
  }
}
