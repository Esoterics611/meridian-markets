import { OptionType } from '../greeks/option-pricer.interface';

// DeribitClient — public Deribit v2 REST for the option chain + implied vol +
// venue Greeks (STRATEGY_LIBRARY_REWRITE.md #4 data dependency). PUBLIC, no key:
// get_book_summary_by_currency returns mark_iv + underlying + mark_price for the
// WHOLE chain in one call; ticker returns Deribit's own Greeks for cross-check.
// HTTP injected so unit tests run offline. This is the IV-surface source the
// vol-selling family consumes; our BlackScholesPricer recomputes Greeks from the
// same mark_iv (and we assert they agree with Deribit's, on real data).

export type DrbHttpGet = (url: string) => Promise<unknown>;

const defaultHttpGet: DrbHttpGet = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Deribit GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export interface DeribitOption {
  instrumentName: string;
  currency: string;
  type: OptionType;
  strike: number;
  expiryMs: number;
  /** Implied vol as a FRACTION (Deribit reports mark_iv in %). */
  markIv: number;
  /** Spot/index underlying price, USD. */
  underlyingPrice: number;
  /** Mark premium, in units of the underlying coin (Deribit convention). */
  markPriceCoin: number;
  openInterest: number;
  volume: number;
}

/** Parse a Deribit option name 'BTC-4JUN26-79000-C' → its terms (08:00 UTC settle). */
export function parseInstrumentName(name: string): { currency: string; type: OptionType; strike: number; expiryMs: number } | null {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(name.trim().toUpperCase());
  if (!m) return null;
  const [, currency, dd, mon, yy, strike, cp] = m;
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const expiryMs = Date.UTC(2000 + Number(yy), month, Number(dd), 8, 0, 0);
  return { currency, type: cp === 'C' ? 'CALL' : 'PUT', strike: Number(strike), expiryMs };
}

interface RawSummary {
  instrument_name: string;
  mark_iv?: number;
  underlying_price?: number;
  mark_price?: number;
  open_interest?: number;
  volume?: number;
}

interface RawTicker {
  mark_iv?: number;
  underlying_price?: number;
  mark_price?: number;
  greeks?: { delta?: number; gamma?: number; vega?: number; theta?: number; rho?: number };
}

export interface DeribitClientOptions {
  baseUrl?: string;
  httpGet?: DrbHttpGet;
}

export class DeribitClient {
  private readonly baseUrl: string;
  private readonly httpGet: DrbHttpGet;

  constructor(opts: DeribitClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://www.deribit.com').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultHttpGet;
  }

  /** The full option chain for a currency (BTC/ETH), with mark IV + underlying. */
  async optionChain(currency: string): Promise<DeribitOption[]> {
    const url = `${this.baseUrl}/api/v2/public/get_book_summary_by_currency?currency=${encodeURIComponent(currency.toUpperCase())}&kind=option`;
    const raw = await this.httpGet(url);
    const rows = (raw as { result?: RawSummary[] })?.result;
    if (!Array.isArray(rows)) throw new Error(`Deribit optionChain: bad response for ${currency}`);
    const out: DeribitOption[] = [];
    for (const r of rows) {
      const parsed = parseInstrumentName(r.instrument_name);
      if (!parsed || r.mark_iv == null || r.underlying_price == null) continue;
      out.push({
        instrumentName: r.instrument_name,
        currency: parsed.currency,
        type: parsed.type,
        strike: parsed.strike,
        expiryMs: parsed.expiryMs,
        markIv: r.mark_iv / 100, // % → fraction
        underlyingPrice: r.underlying_price,
        markPriceCoin: r.mark_price ?? 0,
        openInterest: r.open_interest ?? 0,
        volume: r.volume ?? 0,
      });
    }
    return out;
  }

  /** One instrument's mark IV + Deribit's own Greeks (for cross-checking the pricer). */
  async ticker(instrumentName: string): Promise<{ markIv: number; underlyingPrice: number; markPriceCoin: number; greeks: RawTicker['greeks'] }> {
    const url = `${this.baseUrl}/api/v2/public/ticker?instrument_name=${encodeURIComponent(instrumentName)}`;
    const raw = await this.httpGet(url);
    const r = (raw as { result?: RawTicker })?.result;
    if (!r || r.mark_iv == null) throw new Error(`Deribit ticker: bad response for ${instrumentName}`);
    return {
      markIv: r.mark_iv / 100,
      underlyingPrice: r.underlying_price ?? 0,
      markPriceCoin: r.mark_price ?? 0,
      greeks: r.greeks ?? {},
    };
  }
}
