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

// L2 order-book capability — a SECOND, optional seam on top of the OHLCV one.
// Most reference sources expose only candles (an upper bound on fills under the
// fill-on-touch bar model). A source that also publishes a depth-of-book lets the
// MM backtest become queue-aware (FIFO position → honest fills, course A.10):
// Hyperliquid's public `l2Book` POST gives a no-key 20×20 book. The snapshot type
// is deliberately a STRUCTURAL COPY of market-making's OrderBook (priceMicros /
// sizeUnits / orderCount) rather than an import — keeping market-data free of any
// market-making dependency (CLAUDE.md §6: copy the type, don't couple the module).
// A one-line adapter on the consumer side bridges the two.

/** One price level of a depth snapshot. Mirrors microstructure/OrderBookLevel. */
export interface L2Level {
  /** Price in micros (1.0 quote-unit = 1_000_000). */
  readonly priceMicros: bigint;
  /** Resting size in 6-decimal asset units (1.0 asset = 1_000_000). */
  readonly sizeUnits: bigint;
  /** Number of distinct orders resting at the level (HL's `n`). */
  readonly orderCount: number;
}

/** A depth-of-book snapshot: bids descending by price, asks ascending. */
export interface L2Snapshot {
  readonly symbol: string;
  readonly ts: Date;
  readonly bids: readonly L2Level[];
  readonly asks: readonly L2Level[];
}

/** A source that can return a current L2 depth snapshot (queue-aware fills). */
export interface IL2BookSource {
  /** Current depth-of-book for an internal symbol (a single snapshot — poll for a tape). */
  l2Snapshot(symbol: string): Promise<L2Snapshot>;
}

/** Parse a decimal price/size string to 6-decimal integer units (micros). */
export function decimalToMicros(s: string | number): bigint {
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 1_000_000));
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
