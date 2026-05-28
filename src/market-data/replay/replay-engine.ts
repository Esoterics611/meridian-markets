import { Injectable } from '@nestjs/common';
import { Bar } from '../../stat-arb/backtest/bar';
import { MarketDataRepository, rowToBar } from '../market-data.repository';

// ReplayEngine — streams historical bars from market_bars for backtest
// determinism. Reads a window per (venue, symbol) and exposes a simple
// "next bar" iterator API. The engine doesn't know about strategies — it
// only emits bars in chronological order across all configured symbols.

export interface ReplayWindow {
  venue: string;
  symbols: string[];
  from: Date;
  to: Date;
}

@Injectable()
export class ReplayEngine {
  constructor(private readonly repo: MarketDataRepository) {}

  /**
   * Materialise the full window across every symbol, sorted by timestamp.
   * Suitable for backtests in the 100k-bar range; for larger windows a
   * future iteration could stream via async generator.
   */
  async loadWindow(window: ReplayWindow): Promise<Bar[]> {
    const out: Bar[] = [];
    for (const symbol of window.symbols) {
      const rows = await this.repo.barsBetween(window.venue, symbol, window.from, window.to);
      for (const r of rows) out.push(rowToBar(r));
    }
    out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return out;
  }

  /**
   * Split a window's bars into per-symbol arrays preserving order. Used by
   * the pairs backtest which needs barsA + barsB as parallel arrays.
   */
  async loadPairWindow(
    window: Omit<ReplayWindow, 'symbols'> & { symbolA: string; symbolB: string },
  ): Promise<{ a: Bar[]; b: Bar[] }> {
    const all = await this.loadWindow({
      venue: window.venue,
      symbols: [window.symbolA, window.symbolB],
      from: window.from,
      to: window.to,
    });
    const a: Bar[] = [];
    const b: Bar[] = [];
    for (const bar of all) {
      if (bar.symbol === window.symbolA) a.push(bar);
      else if (bar.symbol === window.symbolB) b.push(bar);
    }
    return { a, b };
  }
}
