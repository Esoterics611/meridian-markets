import { Bar } from '../../stat-arb/backtest/bar';

// Reference market-data sources beyond Binance public spot — the TESSERA
// adapters: Pyth FX OHLC, DefiLlama stablecoin peg, Bit2C (Israeli exchange,
// ILS). Each implements the same minimal contract the OpportunityScanner
// consumes: given an internal symbol, return recent OHLCV Bars. The HTTP call is
// injected (`RefHttpGet`) so unit tests run offline against canned responses —
// the same swap-seam discipline as BinancePublicClient (CLAUDE.md §7).
//
// All of these are PUBLIC endpoints (no API key, no account), so they ride the
// same "paper-trades live data with no credentials" posture as Binance public.

export type RefHttpGet = (url: string) => Promise<unknown>;

export const defaultRefHttpGet: RefHttpGet = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`reference GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

// Some public sources (Hyperliquid, dYdX) expose market data only via a POST with
// a JSON body, not a GET. Injected the same way as RefHttpGet so those clients
// stay offline-testable against canned responses.
export type RefHttpPost = (url: string, body: unknown) => Promise<unknown>;

export const defaultRefHttpPost: RefHttpPost = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reference POST ${url} -> HTTP ${res.status}`);
  return res.json();
};

export interface IReferenceBarSource {
  /** Stable source id: 'pyth' | 'defillama' | 'bit2c'. */
  readonly sourceId: string;
  /** Human label + a sample symbol, for the UI "data sources" readout. */
  readonly label: string;
  readonly sampleSymbol: string;
  /** Most recent `limit` bars for an internal symbol at the given interval. */
  klines(symbol: string, interval: string, limit: number): Promise<Bar[]>;
}

/** A timestamped scalar rate → a flat OHLC bar (open=high=low=close=rate). */
export function ratePointToBar(symbol: string, tsMs: number, rate: number, volume = 0): Bar {
  return { symbol, timestamp: new Date(tsMs), open: rate, high: rate, low: rate, close: rate, volume };
}

/** Seconds per bar for a kline interval string (1m, 5m, 1h, 1d, 1w). */
export function intervalToSeconds(interval: string): number {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim());
  if (!m) return 60;
  const n = Number(m[1]);
  const unit = { m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return Math.max(1, n * unit);
}
