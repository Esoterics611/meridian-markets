import { Bar } from '../../backtest/bar';

// Thin client over Yahoo Finance's chart v8 endpoint for LONG-history daily equity
// bars — the answer to the binding equities constraint (Journal #9/#10): Alpaca's
// data starts ~2016 on BOTH iex and sip, so daily OOS trade counts can't reach the
// n≥20 gate. Yahoo carries split- AND dividend-adjusted daily history back to the
// 1980s for the large caps in EQUITY_PRESETS, free and without a key.
//
// This is a RESEARCH/HISTORY source (the cointegration-stability + OOS scripts),
// NOT a live execution feed — it's EOD, unofficial, and rate-limited. Live trading
// stays on Alpaca (§7 swap seams). Three things that matter:
//
//   1. ADJUSTMENT. We use `adjclose` (split + dividend adjusted) as the close, and
//      scale each bar's O/H/L by adjclose/close so the OHLC stays internally
//      consistent. Unadjusted prices fake spread breaks on ex-div/split dates
//      (course §10.5 — adjustment is non-negotiable for the research series).
//   2. AUTH/UA. No key, but Yahoo rejects a default user agent — we send a browser
//      UA. The HTTP call is injected (`YahooHttpGet`) so unit tests run offline.
//   3. SURVIVORSHIP. Yahoo still only has today's listed tickers, so the
//      survivorship caveat (course §10.5) remains until a point-in-time universe.
//
// Public surface mirrors what the research scripts need:
//   historicalBars(symbol, interval, startMs, endMs)  daily adjusted Bar[]

export const YAHOO_CLIENT = Symbol('YAHOO_CLIENT');

/** Injected transport: GET a URL with headers, resolve parsed JSON. */
export type YahooHttpGet = (url: string, headers: Record<string, string>) => Promise<unknown>;

interface ChartQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}
interface ChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: ChartQuote[];
    adjclose?: { adjclose?: (number | null)[] }[];
  };
}
interface ChartResponse {
  chart?: { result?: ChartResult[] | null; error?: unknown };
}

export interface YahooDailyClientOptions {
  /** Chart API base. Default https://query1.finance.yahoo.com. */
  baseUrl?: string;
  /** Browser UA — Yahoo 403s a default agent. */
  userAgent?: string;
  httpGet?: YahooHttpGet;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const defaultHttpGet: YahooHttpGet = async (url, headers) => {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`Yahoo chart GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

export class YahooDailyClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly httpGet: YahooHttpGet;

  constructor(opts: YahooDailyClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /**
   * Split+dividend-adjusted DAILY bars for [startMs, endMs). `interval` must be
   * daily ('1d'/'1day'); Yahoo's adjclose is only meaningful at the daily grain.
   * Returns oldest-first Bar[] (same shape/ordering as the other clients).
   */
  async historicalBars(symbol: string, interval: string, startMs: number, endMs: number): Promise<Bar[]> {
    if (!/^1\s*d(ay)?$/i.test(interval.trim())) {
      throw new Error(`YahooDailyClient is daily-only; got interval=${interval}`);
    }
    const sym = encodeURIComponent(toYahooSymbol(symbol));
    const p1 = Math.max(0, Math.floor(startMs / 1000));
    const p2 = Math.max(p1 + 1, Math.floor(endMs / 1000));
    const url = `${this.baseUrl}/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
    const raw = (await this.httpGet(url, { 'User-Agent': this.userAgent })) as ChartResponse;
    const result = raw?.chart?.result?.[0];
    if (!result?.timestamp || !result.indicators?.quote?.[0]) return [];

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      if (close == null || open == null || high == null || low == null) continue; // halted/holiday gap
      const aclose = adj?.[i];
      // Scale O/H/L by the dividend/split factor so the whole bar is adjusted.
      const factor = aclose != null && close > 0 ? aclose / close : 1;
      const tMs = ts[i] * 1000;
      if (tMs < startMs || tMs >= endMs) continue;
      out.push({
        symbol,
        timestamp: new Date(tMs),
        open: open * factor,
        high: high * factor,
        low: low * factor,
        close: aclose != null ? aclose : close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return out;
  }
}

/**
 * Map the engine's short symbol to a Yahoo ticker. US tickers pass through
 * (uppercased); class shares use '-' not '.' on Yahoo (BRK.B -> BRK-B).
 */
export function toYahooSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, '-');
}
