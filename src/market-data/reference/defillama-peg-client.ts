import { Bar } from '../../stat-arb/backtest/bar';
import {
  IReferenceBarSource,
  RefHttpGet,
  defaultRefHttpGet,
  ratePointToBar,
} from './reference-source.interface';

// DefiLlama stablecoins — PUBLIC, no key. The current peg price of a stablecoin
// vs USD:
//
//   GET {base}/stablecoins?includePrices=true
//   -> { peggedAssets: [{ symbol, price, ... }, ...] }
//
// DefiLlama's free series is daily, so this is a peg REFERENCE level, not a 1m
// kline feed — klines() returns a single latest bar (the live peg). It powers
// the UI "data sources" readout and a reference read endpoint; it is NOT fed to
// the 1-minute OpportunityScanner (a flat series has no spread to discover).

export interface DefiLlamaClientOptions {
  baseUrl?: string;
  httpGet?: RefHttpGet;
}

export class DefiLlamaPegClient implements IReferenceBarSource {
  readonly sourceId = 'defillama';
  readonly label = 'DefiLlama peg';
  readonly sampleSymbol = 'USDC';
  private readonly baseUrl: string;
  private readonly httpGet: RefHttpGet;

  constructor(opts: DefiLlamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://stablecoins.llama.fi').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultRefHttpGet;
  }

  async klines(symbol: string, _interval = '1m', _limit = 1): Promise<Bar[]> {
    const url = `${this.baseUrl}/stablecoins?includePrices=true`;
    const raw = await this.httpGet(url);
    const price = parseDefiLlamaPeg(symbol, raw);
    return price != null ? [ratePointToBar(symbol, Date.now(), price)] : [];
  }
}

/** Extract a stablecoin's current peg price from the /stablecoins payload. */
export function parseDefiLlamaPeg(symbol: string, raw: unknown): number | null {
  const r = raw as { peggedAssets?: Array<{ symbol?: string; price?: number | null }> };
  if (!r || !Array.isArray(r.peggedAssets)) return null;
  const want = symbol.trim().toUpperCase();
  const hit = r.peggedAssets.find((a) => (a.symbol ?? '').trim().toUpperCase() === want);
  const price = hit?.price;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}
