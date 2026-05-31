import { Bar } from '../../stat-arb/backtest/bar';
import {
  IReferenceBarSource,
  RefHttpGet,
  defaultRefHttpGet,
} from './reference-source.interface';

// Bit2C — Israeli exchange, PUBLIC ticker, no key. The spot reference for the
// ILS basis (e.g. USDC/NIS, BTC/NIS). Endpoint:
//
//   GET {base}/Exchanges/{Pair}/Ticker.json
//   -> { ll, av, a, h, l, ... }   (ll = last price, h/l = 24h high/low)
//
// Bit2C offers no free OHLC history, so klines() returns a single latest bar
// (close = last, high/low from the 24h figures). It powers the UI "data sources"
// readout + reference read endpoint; the on-exchange ILS basis vs the Pyth
// USD/ILS fundamental is the intended trade once a cross-source pairing path
// (per-symbol source + timestamp resampling) lands.

export interface Bit2CClientOptions {
  baseUrl?: string;
  httpGet?: RefHttpGet;
  /** Override internal-symbol → Bit2C pair-path mappings. */
  pairMap?: Record<string, string>;
}

const DEFAULT_PAIR_MAP: Record<string, string> = {
  USDCNIS: 'UsdcNis',
  BTCNIS: 'BtcNis',
  ETHNIS: 'EthNis',
};

export class Bit2CClient implements IReferenceBarSource {
  readonly sourceId = 'bit2c';
  readonly label = 'Bit2C (ILS)';
  readonly sampleSymbol = 'USDCNIS';
  private readonly baseUrl: string;
  private readonly httpGet: RefHttpGet;
  private readonly pairMap: Record<string, string>;

  constructor(opts: Bit2CClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://bit2c.co.il').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultRefHttpGet;
    this.pairMap = { ...DEFAULT_PAIR_MAP, ...(opts.pairMap ?? {}) };
  }

  /** Internal symbol → Bit2C pair path (e.g. 'USDCNIS' → 'UsdcNis'). */
  pairPath(symbol: string): string {
    const key = symbol.trim().toUpperCase();
    if (this.pairMap[key]) return this.pairMap[key];
    // Fallback: 'XXXNIS' → 'XxxNis' (Bit2C's CamelCase pair convention).
    if (key.endsWith('NIS') && key.length > 3) {
      const base = key.slice(0, -3);
      return `${base[0]}${base.slice(1).toLowerCase()}Nis`;
    }
    return key;
  }

  async klines(symbol: string, _interval = '1m', _limit = 1): Promise<Bar[]> {
    const pair = this.pairPath(symbol);
    const url = `${this.baseUrl}/Exchanges/${pair}/Ticker.json`;
    const raw = await this.httpGet(url);
    const bar = parseBit2CTicker(symbol, raw);
    return bar ? [bar] : [];
  }
}

/** Parse a Bit2C ticker payload into a single latest Bar (exported for tests). */
export function parseBit2CTicker(symbol: string, raw: unknown): Bar | null {
  const r = raw as { ll?: number | string; h?: number | string; l?: number | string };
  if (!r) return null;
  const last = Number(r.ll);
  if (!Number.isFinite(last) || last <= 0) return null;
  const high = Number(r.h);
  const low = Number(r.l);
  return {
    symbol,
    timestamp: new Date(),
    open: last,
    high: Number.isFinite(high) && high > 0 ? high : last,
    low: Number.isFinite(low) && low > 0 ? low : last,
    close: last,
    volume: 0,
  };
}
