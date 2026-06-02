import { toBinanceSymbol } from '../../stat-arb/feed/binance-symbol';
import { FundingPoint, FundingSnapshot, IFundingRateSource } from './funding-source.interface';

// BinanceFundingClient — real IFundingRateSource over the Binance USDⓈ-M Futures
// PUBLIC REST API (fapi.binance.com). Public market data only: funding-rate
// history + premium index. No API key, no signing, no account — same posture as
// BinancePublicClient (spot). The HTTP call is injected so unit tests run offline
// with a canned response; the live process uses global fetch.

export type HttpGet = (url: string) => Promise<unknown>;

const defaultHttpGet: HttpGet = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Binance futures GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

type RawFunding = { symbol: string; fundingTime: number; fundingRate: string; markPrice?: string };
type RawPremium = {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
};

export interface BinanceFundingClientOptions {
  /** Base URL — defaults to the public futures API. */
  baseUrl?: string;
  /** Quote asset for the perp market symbol. Default USDT. */
  quote?: string;
  httpGet?: HttpGet;
}

export class BinanceFundingClient implements IFundingRateSource {
  private readonly baseUrl: string;
  private readonly quote: string;
  private readonly httpGet: HttpGet;

  constructor(opts: BinanceFundingClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://fapi.binance.com').replace(/\/+$/, '');
    this.quote = opts.quote ?? 'USDT';
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /**
   * Funding settlements for [startMs, endMs), paginating the 1000-row/req cap.
   * The endpoint returns rows with fundingTime >= startTime ascending; we advance
   * the cursor to the last row's fundingTime+1 until we pass endMs or a short page.
   */
  async fundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
    const market = toBinanceSymbol(symbol, this.quote);
    const out: FundingPoint[] = [];
    let cursor = startMs;
    for (let page = 0; page < 1000 && cursor < endMs; page++) {
      const url =
        `${this.baseUrl}/fapi/v1/fundingRate?symbol=${market}` +
        `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      const raw = await this.httpGet(url);
      if (!Array.isArray(raw) || raw.length === 0) break;
      const batch = raw as RawFunding[];
      for (const r of batch) {
        if (r.fundingTime < endMs) {
          out.push({
            symbol,
            fundingTimeMs: r.fundingTime,
            fundingRate: Number(r.fundingRate),
            markPrice: Number(r.markPrice ?? 0),
          });
        }
      }
      const last = batch[batch.length - 1].fundingTime;
      const next = last + 1;
      if (next <= cursor) break; // no forward progress
      cursor = next;
      if (batch.length < 1000) break; // last (short) page
    }
    return out;
  }

  async currentFunding(symbol: string): Promise<FundingSnapshot> {
    const market = toBinanceSymbol(symbol, this.quote);
    const url = `${this.baseUrl}/fapi/v1/premiumIndex?symbol=${market}`;
    const raw = (await this.httpGet(url)) as RawPremium;
    if (!raw || typeof raw.markPrice !== 'string') {
      throw new Error(`Binance premiumIndex: bad response for ${market}: ${JSON.stringify(raw)}`);
    }
    return {
      symbol,
      lastFundingRate: Number(raw.lastFundingRate),
      nextFundingTimeMs: Number(raw.nextFundingTime),
      markPrice: Number(raw.markPrice),
      indexPrice: Number(raw.indexPrice),
    };
  }
}
