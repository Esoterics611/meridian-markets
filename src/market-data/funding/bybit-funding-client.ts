import { toBinanceSymbol } from '../../stat-arb/feed/binance-symbol';
import { FundingPoint, FundingSnapshot, IFundingRateSource } from './funding-source.interface';

// BybitFundingClient — real IFundingRateSource over the Bybit v5 PUBLIC market API
// (api.bybit.com, category=linear USDT perps). Public market data only — no key, no
// signing, same posture as the Binance/HL funding clients. This is the third leg of
// the cross-venue funding differential board (PROFIT_PIVOT_II E4/R4): HL ↔ Binance ↔
// Bybit on the same symbol.
//
// TWO Bybit specifics vs Binance:
//   1. /v5/market/funding/history returns rows NEWEST-FIRST, max 200/request — so
//      pagination walks BACKWARDS (endTime ← oldest row − 1) and the result is
//      re-sorted chronological to honour the interface contract.
//   2. The funding interval is PER-SYMBOL (8h default, 4h/1h on volatile listings) —
//      consumers must infer cadence from settlement spacing, never assume 8h.
//      (The differential board does exactly that.)
//
// Symbols concatenate the same way as Binance linear markets (BTC → BTCUSDT), so the
// existing toBinanceSymbol helper is reused. Rows carry no mark price (markPrice 0 —
// the staticCarry markRatio guard handles it). HTTP is injected for offline tests.

export type HttpGet = (url: string) => Promise<unknown>;

const defaultHttpGet: HttpGet = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Bybit GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

type RawEnvelope<T> = { retCode?: number; retMsg?: string; result?: T };
type RawFundingList = { list?: { symbol?: string; fundingRate?: string; fundingRateTimestamp?: string }[] };
type RawTickerList = {
  list?: {
    symbol?: string;
    markPrice?: string;
    indexPrice?: string;
    fundingRate?: string;
    nextFundingTime?: string;
  }[];
};

export interface BybitFundingClientOptions {
  /** Base URL — defaults to the public v5 API. */
  baseUrl?: string;
  /** Quote asset for the linear perp symbol. Default USDT. */
  quote?: string;
  httpGet?: HttpGet;
}

export class BybitFundingClient implements IFundingRateSource {
  private readonly baseUrl: string;
  private readonly quote: string;
  private readonly httpGet: HttpGet;

  constructor(opts: BybitFundingClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.bybit.com').replace(/\/+$/, '');
    this.quote = opts.quote ?? 'USDT';
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /**
   * Funding settlements for [startMs, endMs), chronological. Bybit serves pages
   * newest-first (≤200 rows), so the cursor walks the END of the window backwards
   * until a page comes back empty/short or crosses startMs.
   */
  async fundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
    const market = toBinanceSymbol(symbol, this.quote);
    const out: FundingPoint[] = [];
    let cursorEnd = endMs;
    for (let page = 0; page < 1000 && cursorEnd > startMs; page++) {
      const url =
        `${this.baseUrl}/v5/market/funding/history?category=linear&symbol=${market}` +
        `&startTime=${startMs}&endTime=${cursorEnd}&limit=200`;
      const raw = (await this.httpGet(url)) as RawEnvelope<RawFundingList>;
      if (raw?.retCode !== 0) throw new Error(`Bybit funding/history ${market}: retCode ${raw?.retCode} ${raw?.retMsg ?? ''}`);
      const list = raw.result?.list ?? [];
      if (list.length === 0) break;
      let oldest = cursorEnd;
      for (const r of list) {
        const t = Number(r.fundingRateTimestamp);
        const rate = Number(r.fundingRate);
        if (!Number.isFinite(t) || !Number.isFinite(rate)) continue;
        if (t < oldest) oldest = t;
        if (t >= startMs && t < endMs) out.push({ symbol, fundingTimeMs: t, fundingRate: rate, markPrice: 0 });
      }
      const next = oldest - 1;
      if (next >= cursorEnd) break; // no backward progress
      cursorEnd = next;
      if (list.length < 200) break; // short page — history exhausted
    }
    return out.sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  }

  async currentFunding(symbol: string): Promise<FundingSnapshot> {
    const market = toBinanceSymbol(symbol, this.quote);
    const url = `${this.baseUrl}/v5/market/tickers?category=linear&symbol=${market}`;
    const raw = (await this.httpGet(url)) as RawEnvelope<RawTickerList>;
    const t = raw?.result?.list?.[0];
    if (raw?.retCode !== 0 || !t || typeof t.markPrice !== 'string') {
      throw new Error(`Bybit tickers: bad response for ${market}: ${JSON.stringify(raw)?.slice(0, 200)}`);
    }
    const markPrice = Number(t.markPrice);
    return {
      symbol,
      lastFundingRate: Number(t.fundingRate ?? 0),
      nextFundingTimeMs: Number(t.nextFundingTime ?? 0),
      markPrice,
      indexPrice: Number(t.indexPrice ?? markPrice),
    };
  }
}
