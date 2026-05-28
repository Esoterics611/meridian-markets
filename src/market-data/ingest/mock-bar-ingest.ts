import { Injectable } from '@nestjs/common';
import { Bar } from '../../stat-arb/backtest/bar';
import { IBarIngest, IngestedBar } from './bar-ingest.interface';

// MockBarIngest replays a pre-loaded set of {symbol, bars[]} fixtures, one
// batch at a time. Each batch is a "tick" containing the next bar from every
// loaded symbol. Designed for deterministic backtests and the dashboard's
// Data Quality demo.
//
// Threading note: every method is synchronous-on-fast-path. nextBatch is
// async only because IBarIngest is async-typed; there's no I/O inside.

@Injectable()
export class MockBarIngest implements IBarIngest {
  readonly ingestId = 'mock';
  private fixtures: Map<string, Bar[]> = new Map();
  private cursors: Map<string, number> = new Map();
  /** Number of bars per nextBatch() call (one per symbol by default). */
  private batchSize = 1;

  loadFixture(symbol: string, bars: Bar[]): void {
    this.fixtures.set(symbol, bars);
    this.cursors.set(symbol, 0);
  }

  setBatchSize(n: number): void {
    if (n < 1) throw new Error('MockBarIngest.setBatchSize: n must be >= 1');
    this.batchSize = n;
  }

  async nextBatch(): Promise<IngestedBar[]> {
    const out: IngestedBar[] = [];
    for (const [symbol, bars] of this.fixtures.entries()) {
      const start = this.cursors.get(symbol) ?? 0;
      const end = Math.min(start + this.batchSize, bars.length);
      for (let i = start; i < end; i++) {
        out.push({ symbol, bar: bars[i] });
      }
      this.cursors.set(symbol, end);
    }
    return out;
  }

  /** True iff every fixture cursor has reached the end. */
  isExhausted(): boolean {
    for (const [symbol, bars] of this.fixtures.entries()) {
      if ((this.cursors.get(symbol) ?? 0) < bars.length) return false;
    }
    return true;
  }

  reset(): void {
    for (const symbol of this.cursors.keys()) this.cursors.set(symbol, 0);
  }
}
