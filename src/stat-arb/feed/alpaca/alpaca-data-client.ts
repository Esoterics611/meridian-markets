import { Bar } from '../../backtest/bar';

// Thin client over the Alpaca Market Data v2 REST API for US equities — the
// real market-data spine for the equities stat-arb pivot. Mirrors
// BinancePublicClient (one symbol per call, returns the shared Bar[] shape),
// with two equity-specific differences that matter:
//
//   1. AUTH. Alpaca's data API requires a key even for the free IEX feed. The
//      HTTP call is injected (`AlpacaHttpGet`, url + headers) so unit tests run
//      offline; the client builds the APCA auth headers from the configured
//      key/secret and passes them on every request. An unkeyed client throws
//      before it ever hits the wire (a clear failure, not a 403 round-trip).
//
//   2. ADJUSTMENT. Equity prices jump on splits/dividends; an unadjusted series
//      fakes spread breaks and spurious cointegration. We request
//      `adjustment=all` (split + dividend adjusted) for the research/backtest
//      series — non-negotiable (docs/EQUITIES_STATARB_PLAN.md). Live EXECUTION
//      still trades raw prices via the latest-trade endpoint.
//
// Public surface mirrors what the feed / price source / stability script need:
//   historicalBars()  paginated [start,end) bars, adjustment=all   (backtest + stability)
//   recentBars()      most-recent N closed bars                    (live bar feed)
//   latestTrade()     last trade price                             (price source / venue)

export const ALPACA_CLIENT = Symbol('ALPACA_CLIENT');

/** Injected transport: GET a URL with headers, resolve parsed JSON. */
export type AlpacaHttpGet = (url: string, headers: Record<string, string>) => Promise<unknown>;

// An Alpaca bar: ISO timestamp + OHLCV (volume is already numeric, unlike
// Binance's string tuples). `n`/`vw` (trade count / VWAP) are ignored here.
interface RawAlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BarsPage {
  bars?: RawAlpacaBar[] | null;
  next_page_token?: string | null;
  symbol?: string;
}

export interface AlpacaDataClientOptions {
  /** APCA-API-KEY-ID. Required for any real call. */
  keyId?: string;
  /** APCA-API-SECRET-KEY. Required for any real call. */
  secret?: string;
  /** Market-data REST base URL. Default https://data.alpaca.markets. */
  dataBaseUrl?: string;
  /** 'iex' (free tier) | 'sip' (paid full tape) | 'otc'. Default 'iex'. */
  feed?: string;
  httpGet?: AlpacaHttpGet;
}

const MS_PER_MINUTE = 60_000;

const defaultHttpGet: AlpacaHttpGet = async (url, headers) => {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) {
    throw new Error(`Alpaca data GET ${url} -> HTTP ${res.status}`);
  }
  return res.json();
};

export class AlpacaDataClient {
  private readonly keyId: string;
  private readonly secret: string;
  private readonly dataBaseUrl: string;
  private readonly feed: string;
  private readonly httpGet: AlpacaHttpGet;

  constructor(opts: AlpacaDataClientOptions = {}) {
    this.keyId = opts.keyId ?? '';
    this.secret = opts.secret ?? '';
    this.dataBaseUrl = (opts.dataBaseUrl ?? 'https://data.alpaca.markets').replace(/\/+$/, '');
    this.feed = opts.feed ?? 'iex';
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /**
   * Bars for [startMs, endMs), split/dividend adjusted, paginating Alpaca's
   * 10k-bar/page cap via `next_page_token`. Returns oldest-first Bar[] (same
   * shape and ordering as BinancePublicClient.historicalKlines).
   */
  async historicalBars(symbol: string, interval: string, startMs: number, endMs: number): Promise<Bar[]> {
    const tf = toAlpacaTimeframe(interval);
    const sym = encodeURIComponent(symbol.trim().toUpperCase());
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const out: Bar[] = [];
    let pageToken: string | undefined;
    // Guard against an unbounded loop on a misbehaving upstream.
    for (let page = 0; page < 10_000; page++) {
      const params =
        `timeframe=${tf}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
        `&adjustment=all&feed=${this.feed}&limit=10000` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
      const url = `${this.dataBaseUrl}/v2/stocks/${sym}/bars?${params}`;
      const raw = (await this.get(url)) as BarsPage;
      const bars = raw?.bars ?? [];
      for (const b of bars) {
        const bar = this.toBar(symbol, b);
        if (bar.timestamp.getTime() < endMs) out.push(bar);
      }
      const next = raw?.next_page_token;
      if (!next) break;
      pageToken = next;
    }
    return out;
  }

  /**
   * Most-recent `limit` closed bars for the live feed. Alpaca returns bars
   * oldest→newest within [start,end]; without an explicit start it would page
   * from the dawn of history, so we window back a generous multiple of the
   * interval (covering overnight/weekend/holiday gaps) and take the tail.
   */
  async recentBars(symbol: string, interval: string, limit = 2): Promise<Bar[]> {
    const now = Date.now();
    const lookbackMs = Math.max(limit, 2) * intervalMinutes(interval) * MS_PER_MINUTE * 6;
    const bars = await this.historicalBars(symbol, interval, now - lookbackMs, now);
    return bars.slice(-limit);
  }

  /** Last trade price (raw, unadjusted) — what live execution actually pays. */
  async latestTrade(symbol: string): Promise<number> {
    const sym = encodeURIComponent(symbol.trim().toUpperCase());
    const url = `${this.dataBaseUrl}/v2/stocks/${sym}/trades/latest?feed=${this.feed}`;
    const raw = (await this.get(url)) as { trade?: { p?: number } };
    const price = Number(raw?.trade?.p);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Alpaca latest trade: bad price for ${symbol}: ${JSON.stringify(raw)}`);
    }
    return price;
  }

  private async get(url: string): Promise<unknown> {
    if (!this.keyId || !this.secret) {
      throw new Error('Alpaca client is not configured — set ALPACA_KEY_ID and ALPACA_SECRET');
    }
    return this.httpGet(url, {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secret,
    });
  }

  private toBar(symbol: string, b: RawAlpacaBar): Bar {
    return {
      symbol,
      timestamp: new Date(b.t),
      open: Number(b.o),
      high: Number(b.h),
      low: Number(b.l),
      close: Number(b.c),
      volume: Number(b.v),
    };
  }
}

/**
 * Map the engine's interval form ('15m', '1h', '1d') to an Alpaca timeframe
 * ('15Min', '1Hour', '1Day'). Already-Alpaca strings pass through.
 */
export function toAlpacaTimeframe(interval: string): string {
  const s = interval.trim();
  if (/min|hour|day/i.test(s)) return s; // already an Alpaca timeframe
  const m = s.match(/^(\d+)\s*([mhd])$/i);
  if (!m) throw new Error(`unsupported interval for Alpaca: ${interval}`);
  const n = m[1];
  const unit = m[2].toLowerCase();
  if (unit === 'm') return `${n}Min`;
  if (unit === 'h') return `${n}Hour`;
  return `${n}Day`;
}

/** Interval length in minutes — used to window the recent-bars lookback. */
export function intervalMinutes(interval: string): number {
  const m = interval.trim().match(/^(\d+)\s*(min|hour|day|[mhd])$/i);
  if (!m) return 15;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'h' || unit === 'hour') return n * 60;
  if (unit === 'd' || unit === 'day') return n * 60 * 24;
  return n; // 'm' / 'min'
}
