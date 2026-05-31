import { Bar } from '../../stat-arb/backtest/bar';
import { IReferenceBarSource } from './reference-source.interface';
import { PythBenchmarksClient } from './pyth-benchmarks-client';
import { DefiLlamaPegClient } from './defillama-peg-client';
import { Bit2CClient } from './bit2c-client';

// Build the standard set of reference sources from config base URLs. Called from
// both MarketDataModule (reference read endpoint) and StatArbModule (scanner) —
// the clients are stateless HTTP wrappers, so a per-module instance is fine
// (same posture as the duplicated BINANCE_CLIENT provider).
export function buildReferenceSources(opts: {
  pythBaseUrl?: string;
  defillamaBaseUrl?: string;
  bit2cBaseUrl?: string;
}): IReferenceBarSource[] {
  return [
    new PythBenchmarksClient({ baseUrl: opts.pythBaseUrl }),
    new DefiLlamaPegClient({ baseUrl: opts.defillamaBaseUrl }),
    new Bit2CClient({ baseUrl: opts.bit2cBaseUrl }),
  ];
}

// A registry of reference sources keyed by sourceId, plus a BarLoader-shaped
// dispatcher the OpportunityScanner can call as `load(symbol, source)`. Network
// errors collapse to [] so one bad source/symbol never sinks a scan (the scanner
// already drops symbols with too few bars).

export class ReferenceSourceRegistry {
  private readonly sources = new Map<string, IReferenceBarSource>();

  constructor(sources: IReferenceBarSource[] = []) {
    for (const s of sources) this.sources.set(s.sourceId, s);
  }

  get(sourceId: string): IReferenceBarSource | undefined {
    return this.sources.get(sourceId);
  }

  list(): IReferenceBarSource[] {
    return [...this.sources.values()];
  }

  /** Recent bars for one source+symbol (reference read path). */
  async bars(sourceId: string, symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const src = this.sources.get(sourceId);
    if (!src) return [];
    return src.klines(symbol, interval, limit).catch(() => []);
  }
}

/**
 * Build the scanner BarLoader. `source` of 'binance'/undefined routes to the
 * injected Binance loader; any other source id routes to its reference client.
 */
export function makeScannerLoader(
  binanceLoader: (symbol: string) => Promise<Bar[]>,
  registry: ReferenceSourceRegistry,
  interval: string,
  barsToLoad: number,
): (symbol: string, source?: string) => Promise<Bar[]> {
  return async (symbol, source) => {
    if (!source || source === 'binance') return binanceLoader(symbol).catch(() => []);
    return registry.bars(source, symbol, interval, barsToLoad);
  };
}
