import { Injectable } from '@nestjs/common';
import { Bar } from '../../backtest/bar';
import { IBarFeed } from '../live-feed.interface';
import { AlpacaDataClient } from './alpaca-data-client';

// Real streaming bar feed backed by Alpaca equity bars. Implements the same
// IBarFeed "one bar per call, null when no new bar yet" contract as
// BinancePublicBarFeed, with one equity nuance:
//
//   Equities are NOT 24/7. Alpaca's bars endpoint only returns regular-session
//   bars, so the feed never sees overnight/weekend bars — the per-symbol
//   openTime cursor handles the gaps for free (the next session's first bar is
//   simply the next openTime past the cursor). alignMany() then drops any
//   timestamp not common to both legs, so a session-bounded pair aligns cleanly.
//
// We pull the last two bars and use index 0 (the just-closed bar) so we never
// hand out a still-forming bar, exactly like the Binance feed.

@Injectable()
export class AlpacaBarFeed implements IBarFeed {
  readonly feedId: string;
  private readonly lastOpenTimeMs = new Map<string, number>();

  constructor(
    private readonly client: AlpacaDataClient,
    private readonly interval = '15m',
    feedTag = 'iex',
  ) {
    this.feedId = `alpaca.${feedTag}`;
  }

  async nextBar(symbol: string): Promise<Bar | null> {
    const bars = await this.client.recentBars(symbol, this.interval, 2);
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
