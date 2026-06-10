import {
  AggressorFlow,
  ITradeStream,
  MinimalWs,
  RefWsEvent,
  RefWsFactory,
  decimalToMicros,
  defaultRefWsFactory,
} from './reference-source.interface';

// Hyperliquid trade stream — REAL per-trade aggressor flow over HL's public
// WebSocket, replacing the candle-volume ESTIMATE that mm-l2-session used to feed
// the queue-aware backtest (Journal #20/#21: the candle estimate could not resolve
// the top-of-book turnover that fills a passive maker, so every γ/κ combo filled 0).
//
// HL's `l2Book`/`candleSnapshot` are request/response POSTs (HyperliquidClient);
// per-trade prints come ONLY over the WS:
//
//   wss://api.hyperliquid.xyz/ws
//   -> send {"method":"subscribe","subscription":{"type":"trades","coin":"BTC"}}
//   <- {"channel":"trades","data":[{coin,side,px,sz,time,hash,tid,users}, ...]}
//
// `side` is HL's TAKER side: 'B' = a buy aggressor lifted the ask (aggressive BUY),
// 'A' = a sell aggressor hit the bid (aggressive SELL). We fold each print into a
// per-coin running (buy, sell, count, hi, lo) accumulator; `drain(coin)` returns the
// AggressorFlow since the last drain and resets it — one drain per L2 tape step. The
// WS transport is injected (RefWsFactory) so the parse + accumulate logic is offline-
// testable against canned frames, the same discipline as RefHttpGet/Post.

// HL coin keys are EXACT-CASE, with two case quirks (both verified 2026-06-10 against
// the live info endpoint — the wrong case returns null/HTTP 500):
//  1. HIP-3 markets are "<dex>:<ASSET>" with a LOWER-case dex prefix and an UPPER-case
//     asset ("xyz:GOLD" answers; "XYZ:GOLD" and "xyz:gold" both fail).
//  2. "k-coins" (1000× denominations: kPEPE, kBONK, kSHIB …) keep a literal LOWER-case
//     'k' prefix ("KPEPE" fails). A leading lower-case 'k' in the input is preserved;
//     all-caps coins that genuinely start with K (KAVA) are untouched — so write
//     k-coins with their lower-case k.
// Every coin we send, subscribe to, or key an accumulator on must round-trip through
// this, never a bare toUpperCase().
function mainDexCoin(s: string): string {
  if (s.length > 1 && s[0] === 'k') return 'k' + s.slice(1).toUpperCase();
  return s.toUpperCase();
}
export function hlCoin(symbol: string): string {
  const s = symbol.trim();
  const i = s.indexOf(':');
  if (i < 0) return mainDexCoin(s);
  return s.slice(0, i).toLowerCase() + ':' + mainDexCoin(s.slice(i + 1).trim());
}

/** One parsed Hyperliquid trade print. */
export interface HlTrade {
  readonly coin: string;
  /** HL taker side: 'B' = aggressive buy (lifted ask), 'A' = aggressive sell (hit bid). */
  readonly side: 'B' | 'A';
  readonly priceMicros: bigint;
  readonly sizeUnits: bigint;
  readonly tsMs: number;
}

/**
 * Parse a Hyperliquid trades payload into HlTrades (exported for tests). Accepts
 * either the WS envelope `{channel:'trades', data:[...]}` or a bare `[...]` array.
 * Drops malformed / zero-size / unknown-side rows.
 */
export function parseHyperliquidTrades(raw: unknown): HlTrade[] {
  const env = raw as { data?: unknown };
  const arr: unknown[] = Array.isArray(raw) ? raw : Array.isArray(env?.data) ? (env.data as unknown[]) : [];
  const out: HlTrade[] = [];
  for (const row of arr) {
    const r = row as { coin?: string; side?: string; px?: string | number; sz?: string | number; time?: number };
    const side = r?.side === 'B' ? 'B' : r?.side === 'A' ? 'A' : undefined;
    const sizeUnits = decimalToMicros(r?.sz ?? 0);
    if (!side || sizeUnits <= 0n) continue;
    out.push({
      coin: hlCoin(String(r?.coin ?? '')),
      side,
      priceMicros: decimalToMicros(r?.px ?? 0),
      sizeUnits,
      tsMs: Number.isFinite(Number(r?.time)) ? Number(r!.time) : Date.now(),
    });
  }
  return out;
}

interface Acc {
  buy: bigint;
  sell: bigint;
  count: number;
  hi?: bigint;
  lo?: bigint;
}

const ZERO_FLOW: AggressorFlow = { aggressiveBuyUnits: 0n, aggressiveSellUnits: 0n, tradeCount: 0 };

export interface HyperliquidTradeStreamOptions {
  /** WS url, e.g. wss://api.hyperliquid.xyz/ws (derived from the REST base by the client). */
  wsUrl: string;
  /** Symbols (HL coin names) to subscribe to. */
  symbols: string[];
  /** Injected socket factory (defaults to the global WebSocket). */
  wsFactory?: RefWsFactory;
  /** Keep-alive ping cadence in ms (HL drops idle sockets ~60s). 0 disables. Default 30s. */
  heartbeatMs?: number;
}

/** A live HL aggressor stream. Constructed open; drain once per tape step; close when done. */
export class HyperliquidTradeStream implements ITradeStream {
  private ws?: MinimalWs;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly acc = new Map<string, Acc>();
  private readonly symbols: string[];
  private readonly heartbeatMs: number;

  constructor(opts: HyperliquidTradeStreamOptions) {
    this.symbols = opts.symbols.map((s) => hlCoin(s)).filter(Boolean);
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    for (const c of this.symbols) this.acc.set(c, { buy: 0n, sell: 0n, count: 0 });
    const factory = opts.wsFactory ?? defaultRefWsFactory;
    this.ws = factory(opts.wsUrl);
    this.ws.addEventListener('open', () => this.onOpen());
    this.ws.addEventListener('message', (ev: RefWsEvent) => this.onMessage(ev));
    this.ws.addEventListener('close', () => this.stopHeartbeat());
    // Errors are swallowed: a dropped stream just means a step falls back to the
    // candle estimate. The live caller already tolerates 0-trade drains.
    this.ws.addEventListener('error', () => undefined);
  }

  private onOpen(): void {
    for (const coin of this.symbols) this.send({ method: 'subscribe', subscription: { type: 'trades', coin } });
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.send({ method: 'ping' }), this.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  private onMessage(ev: RefWsEvent): void {
    const data = ev?.data;
    let parsed: unknown;
    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      return;
    }
    const channel = (parsed as { channel?: string })?.channel;
    if (channel !== undefined && channel !== 'trades') return; // subscriptionResponse / pong / other
    this.ingest(parseHyperliquidTrades(parsed));
  }

  /** Fold a batch of parsed trades into the per-coin accumulators (exposed for tests). */
  ingest(trades: HlTrade[]): void {
    for (const t of trades) {
      const a = this.acc.get(t.coin);
      if (!a) continue; // a coin we didn't subscribe to
      if (t.side === 'B') a.buy += t.sizeUnits;
      else a.sell += t.sizeUnits;
      a.count += 1;
      if (t.priceMicros > 0n) {
        a.hi = a.hi === undefined || t.priceMicros > a.hi ? t.priceMicros : a.hi;
        a.lo = a.lo === undefined || t.priceMicros < a.lo ? t.priceMicros : a.lo;
      }
    }
  }

  drain(symbol: string): AggressorFlow {
    const key = hlCoin(symbol);
    const a = this.acc.get(key);
    if (!a || a.count === 0) return ZERO_FLOW;
    const flow: AggressorFlow = {
      aggressiveBuyUnits: a.buy,
      aggressiveSellUnits: a.sell,
      tradeCount: a.count,
      ...(a.hi !== undefined ? { highMicros: a.hi } : {}),
      ...(a.lo !== undefined ? { lowMicros: a.lo } : {}),
    };
    this.acc.set(key, { buy: 0n, sell: 0n, count: 0 });
    return flow;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = undefined;
  }

  private send(body: unknown): void {
    try {
      this.ws?.send(JSON.stringify(body));
    } catch {
      /* socket not open / already closed */
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
