import { FundingPoint, FundingSnapshot, IFundingRateSource } from './funding-source.interface';
import { hlCoin } from '../reference/hyperliquid-trades';

// HyperliquidFundingClient — real IFundingRateSource over Hyperliquid's public
// `info` POST (api.hyperliquid.xyz). No key, no signing, same posture as the spot
// reference client. HL is the desk's default MM venue (a maker-rebate perp CLOB),
// so the funding it pays/charges accrues on whatever inventory the MM book holds —
// the carry leg the queue-aware book did not yet price (MM course §8.10).
//
// TWO HL specifics vs Binance: (1) funding settles HOURLY, not every 8h
// (periodsPerYear 8760 vs 1095 — passed into staticCarry); (2) the endpoints are
// POSTs with a JSON body:
//
//   POST /info {"type":"fundingHistory","coin":"BTC","startTime":ms,"endTime":ms}
//     -> [{coin, fundingRate:"0.0000125", premium:"...", time: ms}, ...]   (no mark)
//   POST /info {"type":"metaAndAssetCtxs"}
//     -> [ {universe:[{name,...}]}, [{funding, markPx, oraclePx, ...}, ...] ]  (parallel)
//
// fundingHistory rows carry NO mark price; staticCarry's markRatio guard handles
// that (markPrice 0 ⇒ accrue on entry notional). The HTTP call is injected so the
// parsers are unit-tested offline against canned payloads.

export type HttpPost = (url: string, body: unknown) => Promise<unknown>;

const defaultHttpPost: HttpPost = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info POST ${url} -> HTTP ${res.status}`);
  return res.json();
};

const HOUR_MS = 3_600_000;
/** HL settles funding hourly ⇒ 24×365 settlements/year. Pass to staticCarry. */
export const HYPERLIQUID_PERIODS_PER_YEAR = 24 * 365;

export interface HyperliquidFundingClientOptions {
  baseUrl?: string;
  httpPost?: HttpPost;
}

export class HyperliquidFundingClient implements IFundingRateSource {
  private readonly baseUrl: string;
  private readonly httpPost: HttpPost;

  constructor(opts: HyperliquidFundingClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
    this.httpPost = opts.httpPost ?? defaultHttpPost;
  }

  /**
   * Hourly funding settlements for [startMs, endMs). HL caps a response at 500 rows
   * (~20 days), so paginate by advancing the cursor past the last row's time.
   */
  async fundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
    const coin = hlCoin(symbol);
    const out: FundingPoint[] = [];
    let cursor = startMs;
    for (let page = 0; page < 1000 && cursor < endMs; page++) {
      const raw = await this.httpPost(`${this.baseUrl}/info`, {
        type: 'fundingHistory',
        coin,
        startTime: cursor,
        endTime: endMs,
      });
      const batch = parseHyperliquidFundingHistory(symbol, raw, endMs);
      if (batch.length === 0) break;
      out.push(...batch);
      const last = batch[batch.length - 1].fundingTimeMs;
      const next = last + 1;
      if (next <= cursor) break; // no forward progress
      cursor = next;
      if (batch.length < 500) break; // last (short) page
    }
    return out;
  }

  async currentFunding(symbol: string): Promise<FundingSnapshot> {
    // HIP-3 (F0.4): a builder-deployed perp ("xyz:GOLD") lives on its own dex — the main-dex
    // metaAndAssetCtxs does not list it (this used to throw "not in universe" and the callers
    // silently zeroed the funding term). The SAME info type takes a `dex` field; route by the
    // symbol's dex prefix so per-dex funding is measured, not 0 by construction.
    const dex = hipDex(symbol);
    const body = dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' };
    const raw = await this.httpPost(`${this.baseUrl}/info`, body);
    return parseHyperliquidAssetCtxs(symbol, raw);
  }
}

/** The HIP-3 dex prefix of a symbol ("xyz:GOLD" → "xyz"), or null for a main-dex coin. */
export function hipDex(symbol: string): string | null {
  const i = symbol.indexOf(':');
  return i > 0 ? symbol.slice(0, i).trim().toLowerCase() : null;
}

/** Parse an HL fundingHistory payload → FundingPoints (exported for tests). */
export function parseHyperliquidFundingHistory(symbol: string, raw: unknown, endMs = Infinity): FundingPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: FundingPoint[] = [];
  for (const row of raw) {
    const r = row as { fundingRate?: string | number; time?: number };
    const time = Number(r?.time);
    const rate = Number(r?.fundingRate);
    if (!Number.isFinite(time) || !Number.isFinite(rate) || time >= endMs) continue;
    // HL fundingHistory carries no mark price; markRatio guard in staticCarry handles 0.
    out.push({ symbol, fundingTimeMs: time, fundingRate: rate, markPrice: 0 });
  }
  return out;
}

/**
 * Parse an HL metaAndAssetCtxs payload → the current FundingSnapshot for one coin.
 * The payload is `[ {universe:[{name}]}, [ctx] ]` with the two arrays parallel by
 * index. nextFundingTime is the next hour boundary (HL funds on the hour).
 */
// Per-dex (HIP-3) note: currentFunding() routes a prefixed symbol ("xyz:GOLD") to the same
// info type with `dex: "xyz"`. The per-dex universe may name the coin with OR without its
// dex prefix, so the matcher below accepts both forms.
export function parseHyperliquidAssetCtxs(symbol: string, raw: unknown, nowMs = Date.now()): FundingSnapshot {
  const coin = hlCoin(symbol);
  // Accept both naming forms in the universe: "xyz:GOLD" (fully qualified) and "GOLD"
  // (dex-local, as a per-dex response may name it).
  const bare = coin.includes(':') ? coin.slice(coin.indexOf(':') + 1) : coin;
  const pair = raw as [{ universe?: { name?: string }[] }, Record<string, string>[]] | undefined;
  const universe = pair?.[0]?.universe;
  const ctxs = pair?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) {
    throw new Error(`Hyperliquid metaAndAssetCtxs: bad response shape for ${coin}`);
  }
  const idx = universe.findIndex((u) => u?.name === coin || u?.name === bare);
  const ctx = idx >= 0 ? ctxs[idx] : undefined;
  if (!ctx) throw new Error(`Hyperliquid metaAndAssetCtxs: coin ${coin} not in universe`);
  const markPrice = Number(ctx.markPx ?? 0);
  return {
    symbol,
    lastFundingRate: Number(ctx.funding ?? 0),
    nextFundingTimeMs: Math.ceil(nowMs / HOUR_MS) * HOUR_MS,
    markPrice,
    indexPrice: Number(ctx.oraclePx ?? markPrice),
  };
}
