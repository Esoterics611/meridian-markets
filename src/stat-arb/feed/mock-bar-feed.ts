import { Injectable } from '@nestjs/common';
import { Bar } from '../backtest/bar';
import { IBarFeed } from './live-feed.interface';
import { generateSyntheticFeed, SyntheticFeedConfig } from '../backtest/synthetic-feed';

// MockBarFeed wraps the deterministic generateSyntheticFeed in streaming
// semantics: each nextBar() call returns the next bar for the requested
// symbol, or null when the underlying fixture is exhausted.
//
// Two symbols are tracked from a single fixture so that A and B advance
// together (one bar per symbol per "tick"). The constructor preloads the
// full fixture once; nextBar walks a per-symbol cursor.

@Injectable()
export class MockBarFeed implements IBarFeed {
  readonly feedId = 'mock';
  private bars: Record<string, Bar[]> = {};
  private cursors: Record<string, number> = {};

  loadFixture(cfg: SyntheticFeedConfig): void {
    const { a, b } = generateSyntheticFeed(cfg);
    this.bars[cfg.symbolA] = a;
    this.bars[cfg.symbolB] = b;
    this.cursors[cfg.symbolA] = 0;
    this.cursors[cfg.symbolB] = 0;
  }

  /** Used by integration tests that want to inject pre-computed bars directly. */
  loadBars(symbol: string, bars: Bar[]): void {
    this.bars[symbol] = bars;
    this.cursors[symbol] = 0;
  }

  async nextBar(symbol: string): Promise<Bar | null> {
    const arr = this.bars[symbol];
    if (!arr) return null;
    const idx = this.cursors[symbol] ?? 0;
    if (idx >= arr.length) return null;
    this.cursors[symbol] = idx + 1;
    return arr[idx];
  }

  /** Reset all per-symbol cursors. Test/demo only. */
  reset(): void {
    for (const s of Object.keys(this.cursors)) this.cursors[s] = 0;
  }
}
