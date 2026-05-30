import { Inject, Injectable, Logger } from '@nestjs/common';
import { BinancePublicClient, BINANCE_CLIENT } from '../../stat-arb/feed/binance-public-client';
import { MarketDataRepository } from '../market-data.repository';

// Real historical-bar backfill from Binance public klines into market_bars.
//
// INTERIM: this lives inside meridian-markets so the engine can backtest on
// real data today. The long-term home for market data is a DEDICATED data
// platform repo (see CLAUDE.md §1) that meridian-markets consumes over a
// contract — not an in-process module. Keep this lean; do not grow a
// Bloomberg-terminal here.
//
// Symbols are stored under their internal short form ('BTC'), matching what
// the strategy/replay layer queries by. Venue label is the feed id.

export interface BackfillRequest {
  symbols: string[];
  interval?: string;
  fromMs: number;
  toMs: number;
  venue?: string;
}

export interface BackfillResult {
  symbol: string;
  fetched: number;
  inserted: number;
}

@Injectable()
export class BinanceBackfillService {
  private readonly logger = new Logger(BinanceBackfillService.name);

  constructor(
    @Inject(BINANCE_CLIENT) private readonly client: BinancePublicClient,
    private readonly repo: MarketDataRepository,
  ) {}

  async backfill(req: BackfillRequest): Promise<BackfillResult[]> {
    const interval = req.interval ?? '1m';
    const venue = req.venue ?? 'binance.spot';
    const out: BackfillResult[] = [];
    for (const symbol of req.symbols) {
      // Per-symbol isolation: a delisted/renamed ticker (e.g. MATIC→POL) makes
      // Binance 400 on that symbol. Don't let it abort the whole preset — log
      // it, record 0, and keep backfilling the rest.
      try {
        const bars = await this.client.historicalKlines(symbol, interval, req.fromMs, req.toMs);
        const inserted = await this.repo.insertBars(bars.map((bar) => ({ venue, symbol, bar })));
        this.logger.log(`backfill ${symbol} ${interval}: fetched ${bars.length}, inserted ${inserted}`);
        out.push({ symbol, fetched: bars.length, inserted });
      } catch (err) {
        this.logger.warn(`backfill ${symbol} ${interval} failed (skipped): ${(err as Error).message}`);
        out.push({ symbol, fetched: 0, inserted: 0 });
      }
    }
    return out;
  }
}
