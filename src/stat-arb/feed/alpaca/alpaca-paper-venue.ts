import {
  Fill,
  ITradingVenue,
  PlaceOrderRequest,
} from '../../trading-venue.interface';

// AlpacaPaperVenue — an ITradingVenue that submits orders to Alpaca's PAPER
// trading API (https://paper-api.alpaca.markets). Unlike the in-memory
// PaperVenue (which simulates fills locally), this routes to Alpaca's paper
// matching engine, so it exercises the REAL order path: market-hours
// validation, halts, and short-locate are enforced server-side. Same REST API
// as live, so a green paper round-trip is the strongest pre-live signal.
//
// Two equity nuances baked in:
//   • SHORTING needs whole-share `qty` — Alpaca forbids fractional/notional
//     SELL-short orders. We size every order in whole shares (qty = notional /
//     last price), which also keeps the reported fill notional tied out exactly
//     (filledUnits = qty × priceMicros). At desk scale ($100k/leg) the
//     whole-share rounding is immaterial.
//   • COMMISSION = 0 — Alpaca US equities are commission-free, so feesUnits is
//     0n. The real costs (spread, impact, short-borrow) live in the backtest
//     cost model (HistoricalReplayVenue), not here.
//
// The HTTP POST is injected so unit tests run offline; live submits need the
// user's ALPACA_* paper key.

export type AlpacaHttpPost = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

const defaultHttpPost: AlpacaHttpPost = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Alpaca order POST ${url} -> HTTP ${res.status}`);
  }
  return res.json();
};

export interface AlpacaPaperVenueDeps {
  keyId: string;
  secret: string;
  /** Paper trading REST base URL. Default https://paper-api.alpaca.markets. */
  tradingBaseUrl?: string;
  /** Last RAW trade price in micros (what fills cost) — typically AlpacaPriceSource.priceMicros. */
  priceMicros: (symbol: string) => Promise<bigint>;
  httpPost?: AlpacaHttpPost;
  venueId?: string;
}

interface AlpacaOrderResponse {
  id?: string;
  status?: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
}

export class AlpacaPaperVenue implements ITradingVenue {
  readonly venueId: string;
  private readonly tradingBaseUrl: string;
  private readonly httpPost: AlpacaHttpPost;

  constructor(private readonly deps: AlpacaPaperVenueDeps) {
    this.venueId = deps.venueId ?? 'alpaca-paper';
    this.tradingBaseUrl = (deps.tradingBaseUrl ?? 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
    this.httpPost = deps.httpPost ?? defaultHttpPost;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    if (!this.deps.keyId || !this.deps.secret) {
      throw new Error('AlpacaPaperVenue is not configured — set ALPACA_KEY_ID and ALPACA_SECRET');
    }
    if (req.notionalUnits <= 0n) {
      throw new Error(`AlpacaPaperVenue.placeOrder: notionalUnits must be > 0; got ${req.notionalUnits}`);
    }

    const lastMicros = await this.deps.priceMicros(req.symbol);
    if (lastMicros <= 0n) {
      throw new Error(`AlpacaPaperVenue: no price for ${req.symbol}`);
    }
    // Whole shares (no fractional shorting). notionalUnits/priceMicros = shares.
    const qty = req.notionalUnits / lastMicros;
    if (qty <= 0n) {
      throw new Error(
        `AlpacaPaperVenue: notional ${req.notionalUnits} too small for one share of ${req.symbol} at ${lastMicros}`,
      );
    }

    const url = `${this.tradingBaseUrl}/v2/orders`;
    const body = {
      symbol: req.symbol.trim().toUpperCase(),
      qty: qty.toString(),
      side: req.side === 'BUY' ? 'buy' : 'sell',
      type: 'market',
      time_in_force: 'day',
      client_order_id: req.idempotencyKey, // server-side idempotency / dedupe
    };
    const raw = (await this.httpPost(url, this.authHeaders(), body)) as AlpacaOrderResponse;

    // Prefer Alpaca's realised fill price/qty when the order filled synchronously;
    // otherwise report at the last trade (paper market orders fill ~immediately
    // during RTH). priceMicros ties the notional out exactly: qty × priceMicros.
    const fillPriceMicros =
      raw?.filled_avg_price != null && Number(raw.filled_avg_price) > 0
        ? BigInt(Math.round(Number(raw.filled_avg_price) * 1e6))
        : lastMicros;
    const filledQty = raw?.filled_qty != null && Number(raw.filled_qty) > 0 ? BigInt(Math.trunc(Number(raw.filled_qty))) : qty;

    return {
      orderId: raw?.id ?? `${this.venueId}-${req.idempotencyKey}`,
      symbol: req.symbol,
      side: req.side,
      filledUnits: filledQty * fillPriceMicros,
      priceMicros: fillPriceMicros,
      feesUnits: 0n, // commission-free US equities
      executedAt: new Date(),
    };
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    return this.deps.priceMicros(symbol);
  }

  private authHeaders(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.deps.keyId,
      'APCA-API-SECRET-KEY': this.deps.secret,
    };
  }
}
