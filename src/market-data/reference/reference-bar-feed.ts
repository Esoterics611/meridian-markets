import { Bar } from '../../stat-arb/backtest/bar';
import { IBarFeed } from '../../stat-arb/feed/live-feed.interface';
import { IPriceSource, toMicros } from '../../stat-arb/feed/price-source';
import { IReferenceBarSource } from './reference-source.interface';

// Streaming bar feed + fill-price source backed by a reference data source
// (Pyth FX, ...), so a reference-source pair trades on the SAME live loop as a
// Binance pair. Mirrors BinancePublicBarFeed's contract: emit the just-closed
// bar only when its open time advanced past the last one handed out; otherwise
// null (the loop paces itself). On a closed/illiquid market the source returns
// no new bar and the book simply idles — no crash.

export class ReferenceBarFeed implements IBarFeed {
  readonly feedId: string;
  private readonly lastOpenMs = new Map<string, number>();

  constructor(
    private readonly source: IReferenceBarSource,
    private readonly interval = '1m',
  ) {
    this.feedId = `ref.${source.sourceId}`;
  }

  async nextBar(symbol: string): Promise<Bar | null> {
    const bars = await this.source.klines(symbol, this.interval, 2).catch(() => [] as Bar[]);
    if (bars.length === 0) return null;
    const closed = bars.length >= 2 ? bars[bars.length - 2] : bars[bars.length - 1];
    const openMs = closed.timestamp.getTime();
    const prev = this.lastOpenMs.get(symbol);
    if (prev !== undefined && openMs <= prev) return null;
    this.lastOpenMs.set(symbol, openMs);
    return closed;
  }
}

/** Fill-price source for PaperVenue, reading the latest close from a reference source. */
export class ReferencePriceSource implements IPriceSource {
  constructor(
    private readonly source: IReferenceBarSource,
    private readonly interval = '1m',
  ) {}

  async priceMicros(symbol: string): Promise<bigint> {
    const bars = await this.source.klines(symbol, this.interval, 2).catch(() => [] as Bar[]);
    const last = bars[bars.length - 1];
    if (!last || !(last.close > 0)) throw new Error(`reference price unavailable for ${symbol}`);
    return toMicros(last.close);
  }
}

/** Warm a reference-source book's rolling window from recent aligned klines. */
export async function warmupFromReference(
  source: IReferenceBarSource,
  interval: string,
  symbolA: string,
  symbolB: string,
): Promise<{ a: Bar[]; b: Bar[] }> {
  const [a, b] = await Promise.all([
    source.klines(symbolA, interval, 240).catch(() => [] as Bar[]),
    source.klines(symbolB, interval, 240).catch(() => [] as Bar[]),
  ]);
  const bByTs = new Map(b.map((bar) => [bar.timestamp.getTime(), bar]));
  const outA: Bar[] = [];
  const outB: Bar[] = [];
  for (const barA of a) {
    const barB = bByTs.get(barA.timestamp.getTime());
    if (barB) {
      outA.push(barA);
      outB.push(barB);
    }
  }
  return { a: outA, b: outB };
}
