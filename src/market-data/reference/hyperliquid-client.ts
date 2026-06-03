import { Bar } from '../../stat-arb/backtest/bar';
import {
  IReferenceBarSource,
  RefHttpPost,
  defaultRefHttpPost,
  intervalToSeconds,
} from './reference-source.interface';

// Hyperliquid — the largest on-chain perp DEX, a fully on-chain CLOB (not an AMM).
// This is the maker-rebate ORDER-BOOK venue the MM engine was built for and needs
// to net positive (a ≤0bps maker structure — Journal #6/#23/#16; HL maker fee is a
// −0.2bps rebate). It also exposes a real L2 book + funding (DATA_SOURCES.md). The
// public `info` POST endpoint needs NO key, fitting the paper posture:
//
//   POST {base}/info  {"type":"candleSnapshot","req":{coin,interval,startTime,endTime}}
//   -> [{ t, T, s, i, o, c, h, l, v, n }, ...]   (ms timestamps; o/h/l/c/v are strings)
//
// `coin` is the HL market name (BTC, ETH, SOL, ...). This client returns OHLCV
// candles (the scannable / quotable series); the L2 book is a separate ingest
// (the queue-aware-fills upgrade, tracked separately).

export interface HyperliquidClientOptions {
  baseUrl?: string;
  httpPost?: RefHttpPost;
}

// HL candle intervals: 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M. Our kline
// strings overlap directly; map the few that differ and pass the rest through.
const HL_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']);
export function hyperliquidInterval(interval: string): string {
  const i = interval.trim();
  if (HL_INTERVALS.has(i)) return i;
  if (i === '1M') return '1M';
  return '1h'; // safe default for anything unmapped
}

export class HyperliquidClient implements IReferenceBarSource {
  readonly sourceId = 'hyperliquid';
  readonly label = 'Hyperliquid (perp CLOB)';
  readonly sampleSymbol = 'BTC';
  private readonly baseUrl: string;
  private readonly httpPost: RefHttpPost;

  constructor(opts: HyperliquidClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
    this.httpPost = opts.httpPost ?? defaultRefHttpPost;
  }

  async klines(symbol: string, interval = '1h', limit = 240): Promise<Bar[]> {
    const hlInterval = hyperliquidInterval(interval);
    const lim = Math.max(1, Math.floor(limit));
    const endTime = Date.now();
    const startTime = endTime - intervalToSeconds(hlInterval) * 1000 * lim;
    const raw = await this.httpPost(`${this.baseUrl}/info`, {
      type: 'candleSnapshot',
      req: { coin: symbol.trim().toUpperCase(), interval: hlInterval, startTime, endTime },
    });
    return parseHyperliquidCandles(symbol, raw);
  }
}

/** Parse a Hyperliquid candleSnapshot payload into ascending Bars (exported for tests). */
export function parseHyperliquidCandles(symbol: string, raw: unknown): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const row of raw) {
    const r = row as { t?: number; o?: string | number; h?: string | number; l?: string | number; c?: string | number; v?: string | number };
    const t = Number(r?.t);
    const close = Number(r?.c);
    if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) continue;
    out.push({
      symbol,
      timestamp: new Date(t),
      open: Number(r.o ?? close),
      high: Number(r.h ?? close),
      low: Number(r.l ?? close),
      close,
      volume: Number(r.v ?? 0),
    });
  }
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}
