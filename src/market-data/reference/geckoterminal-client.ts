import { Bar } from '../../stat-arb/backtest/bar';
import {
  IReferenceBarSource,
  RefHttpGet,
  defaultRefHttpGet,
} from './reference-source.interface';

// GeckoTerminal — free, no-key DEX OHLCV across 100+ chains (Uniswap / PancakeSwap
// / Aerodrome AMM + CLOB pools). This is the market-DISCOVERY frontier (CLAUDE.md
// §1, MARKET_MAKING.md "Frontier — DEX / decentralized"): under-watched on-chain
// pools carry structurally wider spreads, and the DEX fee/reward structure (LP
// fees accrue TO the maker, maker rebates) is the ≤0 bps-maker regime the MM book
// needs to clear its structural P&L (Journal #6 / #23). Endpoint:
//
//   GET {base}/networks/{network}/pools/{pool}/ohlcv/{timeframe}
//        ?aggregate={n}&limit={l}&currency=usd
//   -> { data: { attributes: { ohlcv_list: [[tsSec, o, h, l, c, v], ...] } } }
//
// ohlcv_list is newest-first; we sort ascending into chronological Bars. An
// internal symbol maps to a 'network/pool_address' path (poolMap), or is passed
// as that path directly (e.g. 'eth/0x88e6...'), mirroring how PythBenchmarksClient
// accepts a raw shim symbol. PUBLIC endpoint — same no-credentials posture as the
// other reference sources; the free tier is rate-limited (~30 req/min), and the
// loader already collapses errors to [] so a throttle never sinks a scan.

export interface GeckoTerminalClientOptions {
  baseUrl?: string;
  httpGet?: RefHttpGet;
  /** Extra / override internal-symbol → 'network/pool_address' mappings. */
  poolMap?: Record<string, string>;
}

// Verified, high-liquidity DEX pools (24h volume sampled live 2026-06-03 against
// the GeckoTerminal API). 'eth' = Ethereum mainnet, 'base' = Base L2 — two chains
// so the discovery universe already spans venues. Addresses are real Uniswap-v3
// pool contracts; swap in any pool from GeckoTerminal via the poolMap option or a
// raw 'network/0x...' symbol.
const DEFAULT_POOL_MAP: Record<string, string> = {
  WETHUSDC: 'eth/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // Uniswap v3 0.05% — the ETH/USD workhorse
  WETHUSDT: 'eth/0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b', // Uniswap v3 0.01%
  WBTCWETH: 'eth/0x4585fe77225b41b697c938b018e2ac67ac5a20c0', // Uniswap v3 0.05% — the BTC/ETH ratio
  USDCUSDT: 'eth/0xe60b5e323d72a914b089f137ec9b3ab91ae24a65', // Uniswap v3 — on-chain stable peg
  BASEWETHUSDC: 'base/0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', // Base L2 Uniswap v3 0.01%
  BASECBBTCUSDC: 'base/0x4e962bb3889bf030368f56810a9c96b83cb3e778', // Base L2 cbBTC/USDC 0.05%
};

/** Map a kline interval to a GeckoTerminal {timeframe, aggregate}. */
export function geckoTimeframe(interval: string): { timeframe: string; aggregate: number } {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim());
  if (!m) return { timeframe: 'hour', aggregate: 1 };
  const n = Number(m[1]);
  const u = m[2];
  if (u === 'm') {
    const aggregate = n >= 15 ? 15 : n >= 5 ? 5 : 1; // GT minute aggregates: 1, 5, 15
    return { timeframe: 'minute', aggregate };
  }
  if (u === 'h') {
    const aggregate = n >= 12 ? 12 : n >= 4 ? 4 : 1; // GT hour aggregates: 1, 4, 12
    return { timeframe: 'hour', aggregate };
  }
  return { timeframe: 'day', aggregate: 1 }; // d / w → day (GT day aggregate: 1)
}

export class GeckoTerminalClient implements IReferenceBarSource {
  readonly sourceId = 'geckoterminal';
  readonly label = 'GeckoTerminal DEX';
  readonly sampleSymbol = 'WETHUSDC';
  private readonly baseUrl: string;
  private readonly httpGet: RefHttpGet;
  private readonly poolMap: Record<string, string>;

  constructor(opts: GeckoTerminalClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');
    this.httpGet = opts.httpGet ?? defaultRefHttpGet;
    this.poolMap = { ...DEFAULT_POOL_MAP, ...(opts.poolMap ?? {}) };
  }

  /** Internal symbol → 'network/pool_address' path (or raw passthrough). */
  poolPath(symbol: string): string {
    const key = symbol.trim().toUpperCase();
    return this.poolMap[key] ?? symbol.trim();
  }

  async klines(symbol: string, interval = '1h', limit = 240): Promise<Bar[]> {
    const path = this.poolPath(symbol);
    const parts = path.split('/').filter(Boolean);
    const network = parts[0] ?? '';
    const pool = parts[parts.length - 1] ?? ''; // tolerate a stray 'pools/' segment
    const { timeframe, aggregate } = geckoTimeframe(interval);
    const lim = Math.min(1000, Math.max(1, Math.floor(limit)));
    const url =
      `${this.baseUrl}/networks/${network}/pools/${pool}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${lim}&currency=usd`;
    const raw = await this.httpGet(url);
    return parseGeckoTerminalOhlcv(symbol, raw);
  }
}

/** Parse a GeckoTerminal OHLCV payload into ascending Bars (exported for tests). */
export function parseGeckoTerminalOhlcv(symbol: string, raw: unknown): Bar[] {
  const r = raw as { data?: { attributes?: { ohlcv_list?: unknown[] } } };
  const list = r?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Bar[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const ts = Number(row[0]);
    const close = Number(row[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    out.push({
      symbol,
      timestamp: new Date(ts * 1000),
      open: Number(row[1] ?? close),
      high: Number(row[2] ?? close),
      low: Number(row[3] ?? close),
      close,
      volume: Number(row[5] ?? 0),
    });
  }
  // GeckoTerminal returns newest-first; Bars must be chronological (ascending).
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}
