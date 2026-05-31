import { Bar } from '../../stat-arb/backtest/bar';
import {
  IReferenceBarSource,
  RefHttpGet,
  defaultRefHttpGet,
  intervalToSeconds,
} from './reference-source.interface';

// Pyth Benchmarks — the TradingView UDF "shim" exposes real historical OHLC for
// Pyth price feeds (FX, metals, crypto, rates). PUBLIC, no key. Endpoint:
//
//   GET {base}/v1/shims/tradingview/history
//        ?symbol=FX.EUR/USD&resolution=1&from={unixSec}&to={unixSec}
//   -> { s:'ok', t:number[], o:number[], h:number[], l:number[], c:number[], v?:number[] }
//
// We map an internal FX code ('EURUSD') to the shim symbol ('FX.EUR/USD'). This
// is the one reference source that yields true 1-minute OHLC, so it's the source
// the OpportunityScanner actually discovers/ranks FX pairs from.

export interface PythClientOptions {
  baseUrl?: string;
  httpGet?: RefHttpGet;
  /** Extra/override internal-symbol → shim-symbol mappings. */
  symbolMap?: Record<string, string>;
}

const DEFAULT_FX_MAP: Record<string, string> = {
  EURUSD: 'FX.EUR/USD',
  GBPUSD: 'FX.GBP/USD',
  USDJPY: 'FX.USD/JPY',
  USDCHF: 'FX.USD/CHF',
  AUDUSD: 'FX.AUD/USD',
  USDCAD: 'FX.USD/CAD',
  USDILS: 'FX.USD/ILS',
};

/** Map a kline interval to a TradingView UDF resolution string. */
export function pythResolution(interval: string): string {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim());
  if (!m) return '1';
  const n = m[1];
  const u = m[2];
  if (u === 'm') return n; // '1'..'60'
  if (u === 'h') return String(Number(n) * 60);
  if (u === 'd') return '1D';
  return '1W';
}

export class PythBenchmarksClient implements IReferenceBarSource {
  readonly sourceId = 'pyth';
  readonly label = 'Pyth FX';
  readonly sampleSymbol = 'EURUSD';
  private readonly baseUrl: string;
  private readonly httpGet: RefHttpGet;
  private readonly map: Record<string, string>;

  constructor(opts: PythClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://benchmarks.pyth.network').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultRefHttpGet;
    this.map = { ...DEFAULT_FX_MAP, ...(opts.symbolMap ?? {}) };
  }

  /** Internal symbol → Pyth shim symbol (e.g. 'EURUSD' → 'FX.EUR/USD'). */
  shimSymbol(symbol: string): string {
    const key = symbol.trim().toUpperCase();
    if (this.map[key]) return this.map[key];
    if (/^[A-Z]{6}$/.test(key)) return `FX.${key.slice(0, 3)}/${key.slice(3)}`;
    return key; // already a shim symbol like 'FX.EUR/USD'
  }

  async klines(symbol: string, interval = '1m', limit = 240): Promise<Bar[]> {
    const sym = this.shimSymbol(symbol);
    const resolution = pythResolution(interval);
    const to = Math.floor(Date.now() / 1000);
    const from = to - intervalToSeconds(interval) * Math.max(1, limit);
    const url =
      `${this.baseUrl}/v1/shims/tradingview/history` +
      `?symbol=${encodeURIComponent(sym)}&resolution=${resolution}&from=${from}&to=${to}`;
    const raw = await this.httpGet(url);
    return parsePythHistory(symbol, raw);
  }
}

/** Parse a TradingView UDF history payload into Bars (exported for unit tests). */
export function parsePythHistory(symbol: string, raw: unknown): Bar[] {
  const r = raw as {
    s?: string;
    t?: number[];
    o?: number[];
    h?: number[];
    l?: number[];
    c?: number[];
    v?: number[];
  };
  if (!r || r.s !== 'ok' || !Array.isArray(r.t) || !Array.isArray(r.c)) return [];
  const out: Bar[] = [];
  for (let i = 0; i < r.t.length; i++) {
    const close = Number(r.c[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({
      symbol,
      timestamp: new Date(r.t[i] * 1000),
      open: Number(r.o?.[i] ?? close),
      high: Number(r.h?.[i] ?? close),
      low: Number(r.l?.[i] ?? close),
      close,
      volume: Number(r.v?.[i] ?? 0),
    });
  }
  return out;
}
