import { Bar } from '../../stat-arb/backtest/bar';
import { IReferenceBarSource, RefHttpGet, defaultRefHttpGet, intervalToSeconds } from './reference-source.interface';

// Bybit — a top-3 perp CLOB, added as a SECOND order-book venue for the regime desk
// (Playbook II P12: more venues behind IReferenceBarSource). Its v5 public market data
// needs NO API key, fitting the paper posture (same as Binance/HL public):
//
//   GET {base}/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=200
//   -> { retCode, retMsg, result: { symbol, list: [ [startMs, o, h, l, c, vol, turnover], ... ] } }
//
// `list` is NEWEST-FIRST and all OHLCV fields are decimal STRINGS; we reverse to ascending
// and return the same Bar shape every other reference source does, so the board/runner can
// pull a Bybit-listed perp exactly like an HL or Binance one. The HTTP GET is injected so
// unit tests run offline against a canned response (CLAUDE.md §7 swap-seam).

export interface BybitClientOptions {
  baseUrl?: string;
  httpGet?: RefHttpGet;
  /** Quote suffix for the linear perp symbol (BTC → BTCUSDT). Default 'USDT'. */
  quote?: string;
}

// kline string → Bybit v5 interval token.
const BYBIT_INTERVAL: Readonly<Record<string, string>> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M',
};
export function bybitInterval(interval: string): string {
  return BYBIT_INTERVAL[interval.trim()] ?? '60';
}

interface BybitKlineResponse {
  retCode?: number;
  retMsg?: string;
  result?: { symbol?: string; list?: string[][] };
}

export class BybitClient implements IReferenceBarSource {
  readonly sourceId = 'bybit';
  readonly label = 'Bybit (perp CLOB)';
  readonly sampleSymbol = 'BTC';
  private readonly baseUrl: string;
  private readonly httpGet: RefHttpGet;
  private readonly quote: string;

  constructor(opts: BybitClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.bybit.com').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultRefHttpGet;
    this.quote = opts.quote ?? 'USDT';
  }

  /** Internal symbol (BTC) → Bybit linear perp instrument (BTCUSDT). */
  bybitSymbol(symbol: string): string {
    const s = symbol.trim().toUpperCase();
    return s.endsWith(this.quote) ? s : `${s}${this.quote}`;
  }

  async klines(symbol: string, interval = '1h', limit = 240): Promise<Bar[]> {
    const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
    const inst = this.bybitSymbol(symbol);
    const url = `${this.baseUrl}/v5/market/kline?category=linear&symbol=${inst}&interval=${bybitInterval(interval)}&limit=${lim}`;
    const raw = (await this.httpGet(url)) as BybitKlineResponse;
    if (raw?.retCode !== undefined && raw.retCode !== 0) {
      throw new Error(`bybit kline ${inst}: retCode ${raw.retCode} ${raw.retMsg ?? ''}`.trim());
    }
    const list = raw?.result?.list ?? [];
    const bars: Bar[] = [];
    for (const row of list) {
      if (!row || row.length < 6) continue;
      const tsMs = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (!Number.isFinite(tsMs) || !Number.isFinite(close) || close <= 0) continue;
      bars.push({ symbol: symbol.trim().toUpperCase(), timestamp: new Date(tsMs), open, high, low, close, volume });
    }
    // Bybit returns newest-first — ascending is the contract every consumer expects.
    bars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return bars;
  }

  /** Seconds per bar for an interval (re-exported convenience for callers). */
  intervalSeconds(interval: string): number {
    return intervalToSeconds(interval);
  }
}
