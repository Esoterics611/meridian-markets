import { Injectable } from '@nestjs/common';
import { Bar } from '../backtest/bar';
import { IBarFeed } from './live-feed.interface';
import { BinancePublicClient } from './binance-public-client';

// Real streaming bar feed backed by Binance public klines. Implements the
// IBarFeed "one bar per call, null when no new bar yet" contract:
//
//   - nextBar(symbol) fetches the most recent CLOSED bar for the symbol.
//   - It returns that bar only if its open time advanced past the last one
//     handed out for that symbol; otherwise null (real-time semantics — the
//     caller paces the poll loop and gets a fresh bar only when one exists).
//
// We pull the last two klines and use index 0 (the just-closed bar) so we
// never hand out a still-forming bar. Per-symbol cursor lives in-memory; on
// restart the first call re-emits the latest closed bar (idempotent enough
// for a minute-bar loop).

@Injectable()
export class BinancePublicBarFeed implements IBarFeed {
  readonly feedId = 'binance.spot';
  private readonly lastOpenTimeMs = new Map<string, number>();

  constructor(
    private readonly client: BinancePublicClient,
    private readonly interval = '1m',
  ) {}

  async nextBar(symbol: string): Promise<Bar | null> {
    // Two bars: [closed-1, forming]. Use the closed one.
    const bars = await this.client.klines(symbol, this.interval, 2);
    if (bars.length === 0) return null;
    const closed = bars.length >= 2 ? bars[bars.length - 2] : bars[0];
    const openMs = closed.timestamp.getTime();
    const prev = this.lastOpenTimeMs.get(symbol);
    if (prev !== undefined && openMs <= prev) {
      return null; // no new closed bar since last poll
    }
    this.lastOpenTimeMs.set(symbol, openMs);
    return closed;
  }
}
