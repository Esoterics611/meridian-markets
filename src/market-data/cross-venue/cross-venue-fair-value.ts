import { BinancePublicClient } from '../../stat-arb/feed/binance-public-client';
import { HyperliquidClient } from '../reference/hyperliquid-client';
import { L2Snapshot } from '../reference/reference-source.interface';
import { BasisSnapshot, ICrossVenueFairValue } from './cross-venue-fair-value.interface';

export class CrossVenueFairValue implements ICrossVenueFairValue {
  constructor(
    private readonly binance: BinancePublicClient,
    private readonly hl: HyperliquidClient,
  ) {}

  async getBasis(symbol: string): Promise<BasisSnapshot> {
    // Fetch both venues concurrently to minimise time-skew between samples.
    const [binanceResult, hlResult] = await Promise.all([
      this.fetchBinance(symbol),
      this.fetchHl(symbol),
    ]);

    const basis = hlResult.mid - binanceResult.price;
    const capturedAtMs = Math.max(binanceResult.fetchMs, hlResult.fetchMs);

    return {
      symbol,
      capturedAtMs,
      binanceMid: binanceResult.price,
      binanceFetchMs: binanceResult.fetchMs,
      hlMid: hlResult.mid,
      hlServerTsMs: hlResult.serverTsMs,
      hlFetchMs: hlResult.fetchMs,
      basis,
      basisBps: binanceResult.price > 0 ? (basis / binanceResult.price) * 10_000 : 0,
      // HL's own timestamp vs when we received it — a proxy for HL book staleness.
      hlDataAgeMs: hlResult.fetchMs - hlResult.serverTsMs,
      hlBook: hlResult.book,
    };
  }

  private async fetchBinance(symbol: string): Promise<{ price: number; fetchMs: number }> {
    const price = await this.binance.lastPrice(symbol);
    return { price, fetchMs: Date.now() };
  }

  private async fetchHl(symbol: string): Promise<{ mid: number; serverTsMs: number; fetchMs: number; book: L2Snapshot }> {
    const book = await this.hl.l2Snapshot(symbol);
    const fetchMs = Date.now();
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    const mid =
      bestBid && bestAsk
        ? (Number(bestBid.priceMicros) + Number(bestAsk.priceMicros)) / 2 / 1_000_000
        : 0;
    return { mid, serverTsMs: book.ts.getTime(), fetchMs, book };
  }
}
