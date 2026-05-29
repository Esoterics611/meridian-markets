import { Bar } from '../backtest/bar';
import { toBinanceSymbol } from './binance-symbol';

// Thin client over the Binance public spot REST API. PUBLIC market data only:
// klines and last-price. No API key, no signing, no account — these endpoints
// are unauthenticated and free. This is the real market-data spine that the
// live paper loop runs against.
//
// The HTTP call is injected (`HttpGet`) so unit tests run offline with a
// canned response and the live process uses global fetch. Network failures
// surface as thrown errors; the caller (feed/loop) decides retry/backoff.

export const BINANCE_CLIENT = Symbol('BINANCE_CLIENT');

export type HttpGet = (url: string) => Promise<unknown>;

const defaultHttpGet: HttpGet = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Binance public GET ${url} -> HTTP ${res.status}`);
  }
  return res.json();
};

// A Binance kline tuple: [openTime, open, high, low, close, volume, closeTime, ...].
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export interface BinancePublicClientOptions {
  /** Base URL — defaults to the public spot API. Override for testnet/mirror. */
  baseUrl?: string;
  /** Quote asset the engine trades against. Default USDT. */
  quote?: string;
  httpGet?: HttpGet;
}

export class BinancePublicClient {
  private readonly baseUrl: string;
  private readonly quote: string;
  private readonly httpGet: HttpGet;

  constructor(opts: BinancePublicClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.binance.com').replace(/\/+$/, '');
    this.quote = opts.quote ?? 'USDT';
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /** Most recent `limit` OHLCV bars for a symbol at the given interval. */
  async klines(symbol: string, interval = '1m', limit = 200): Promise<Bar[]> {
    const market = toBinanceSymbol(symbol, this.quote);
    const url = `${this.baseUrl}/api/v3/klines?symbol=${market}&interval=${interval}&limit=${limit}`;
    const raw = await this.httpGet(url);
    if (!Array.isArray(raw)) {
      throw new Error(`Binance klines: expected array, got ${typeof raw}`);
    }
    return (raw as RawKline[]).map((k) => this.toBar(symbol, k));
  }

  /**
   * Historical bars for [startMs, endMs), paginating the 1000-bar/req cap.
   * Binance returns bars whose openTime >= startTime; we advance the cursor to
   * the last bar's closeTime+1 each page until we pass endMs or a page is short.
   */
  async historicalKlines(
    symbol: string,
    interval: string,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const market = toBinanceSymbol(symbol, this.quote);
    const out: Bar[] = [];
    let cursor = startMs;
    // Guard against an unbounded loop on a misbehaving upstream.
    for (let page = 0; page < 10_000 && cursor < endMs; page++) {
      const url =
        `${this.baseUrl}/api/v3/klines?symbol=${market}&interval=${interval}` +
        `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      const raw = await this.httpGet(url);
      if (!Array.isArray(raw) || raw.length === 0) break;
      const batch = (raw as RawKline[]).map((k) => this.toBar(symbol, k));
      for (const b of batch) {
        if (b.timestamp.getTime() < endMs) out.push(b);
      }
      const lastClose = (raw as RawKline[])[raw.length - 1][6];
      const nextCursor = Number(lastClose) + 1;
      if (nextCursor <= cursor) break; // no forward progress
      cursor = nextCursor;
      if (raw.length < 1000) break; // last (short) page
    }
    return out;
  }

  /** Last traded price for a symbol, as a float in quote units. */
  async lastPrice(symbol: string): Promise<number> {
    const market = toBinanceSymbol(symbol, this.quote);
    const url = `${this.baseUrl}/api/v3/ticker/price?symbol=${market}`;
    const raw = await this.httpGet(url);
    const obj = raw as { price?: string };
    const price = Number(obj?.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Binance ticker: bad price for ${market}: ${JSON.stringify(raw)}`);
    }
    return price;
  }

  private toBar(symbol: string, k: RawKline): Bar {
    return {
      symbol,
      timestamp: new Date(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    };
  }
}
