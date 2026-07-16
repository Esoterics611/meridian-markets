import {
  L2Snapshot,
  RefHttpPost,
  defaultRefHttpPost,
} from './reference-source.interface';
import { parseHyperliquidL2 } from './hyperliquid-client';

// Hyperliquid SPOT — the venue's native spot order books (HYPE/USDC, PURR/USDC, …),
// same public `info` POST surface as the perp client, no key.
//
// Why this exists (#99 → #100): the carry desk's deployable gate required a Binance
// spot market for the hedge leg, which excluded the single biggest gate-passing
// stream (HYPE: +9.8%/yr funding, $313M/day perp volume — no Binance listing). An
// HL-NATIVE pair (long HL spot / short HL perp) is structurally cleaner than the
// cross-venue books: one venue, one asset id (the #92 ticker-collision class cannot
// exist), no cross-venue basis risk — the residual is USDC/USDT quote drift only.
//
// API shape (probed live 2026-07-16):
//   POST /info {"type":"spotMeta"}
//     -> { tokens: [{name, index, ...}], universe: [{name, tokens:[base,quote], index, isCanonical}] }
//   Spot pair ids are "@<index>" (e.g. HYPE/USDC = "@107", tokens [150, 0]); only
//   canonical pairs (PURR/USDC) use a readable name. Both forms work as `coin` in
//   the standard l2Book request, which returns the same payload as perps.
//
// FEES (verified against the live docs page 2026-07-16, hyperliquid.gitbook.io
// /hyperliquid-docs/trading/fees): spot base tier = taker 7bps / maker 4bps, and
// SPOT HAS NO MAKER REBATE at any base tier — the −0.2bps rebate the desk models
// on HL perps is a maker-volume-share tier that exists for perps only. Priced in
// venue-fees.ts under 'hyperliquid-spot'; do not borrow the perp schedule.

const USDC_TOKEN_INDEX = 0;

interface SpotMetaToken {
  name?: string;
  index?: number;
}

interface SpotMetaPair {
  name?: string;
  tokens?: number[];
  index?: number;
}

export interface ResolvedSpotPair {
  /** The `coin` accepted by l2Book / candleSnapshot ("@107", or "PURR/USDC" for canonical pairs). */
  coin: string;
  pairIndex: number;
}

export interface HyperliquidSpotClientOptions {
  baseUrl?: string;
  httpPost?: RefHttpPost;
  /** spotMeta cache TTL, ms (listings change rarely; default 1h). */
  metaTtlMs?: number;
}

/** Resolve a token name to its USDC spot pair from a spotMeta payload (exported for tests). */
export function resolveSpotPairFromMeta(token: string, meta: unknown): ResolvedSpotPair {
  const m = meta as { tokens?: SpotMetaToken[]; universe?: SpotMetaPair[] };
  const tokens = Array.isArray(m?.tokens) ? m.tokens : [];
  const universe = Array.isArray(m?.universe) ? m.universe : [];
  // HL token names are case-sensitive in spirit (kPEPE), but spot tokens are plain
  // uppercase today — match exact first, then case-insensitive as a fallback.
  const tok =
    tokens.find((t) => t?.name === token) ??
    tokens.find((t) => (t?.name ?? '').toUpperCase() === token.toUpperCase());
  if (!tok || !Number.isFinite(tok.index)) {
    throw new Error(`hyperliquid-spot: token ${token} not in spotMeta (${tokens.length} tokens)`);
  }
  const pair = universe.find((u) => Array.isArray(u?.tokens) && u.tokens[0] === tok.index && u.tokens[1] === USDC_TOKEN_INDEX);
  if (!pair || typeof pair.name !== 'string' || !Number.isFinite(pair.index)) {
    throw new Error(`hyperliquid-spot: no ${token}/USDC pair in spotMeta universe (${universe.length} pairs)`);
  }
  return { coin: pair.name, pairIndex: pair.index! };
}

export class HyperliquidSpotClient {
  readonly sourceId = 'hyperliquid-spot';
  readonly label = 'Hyperliquid (native spot CLOB)';
  private readonly baseUrl: string;
  private readonly httpPost: RefHttpPost;
  private readonly metaTtlMs: number;
  private metaCache: { fetchedMs: number; meta: unknown } | null = null;

  constructor(opts: HyperliquidSpotClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
    this.httpPost = opts.httpPost ?? defaultRefHttpPost;
    this.metaTtlMs = opts.metaTtlMs ?? 3_600_000;
  }

  /** Token name ('HYPE') → its USDC spot pair coin id ('@107'). Meta is cached. */
  async resolveSpotPair(token: string): Promise<ResolvedSpotPair> {
    const now = Date.now();
    if (!this.metaCache || now - this.metaCache.fetchedMs > this.metaTtlMs) {
      const meta = await this.httpPost(`${this.baseUrl}/info`, { type: 'spotMeta' });
      this.metaCache = { fetchedMs: now, meta };
    }
    return resolveSpotPairFromMeta(token, this.metaCache.meta);
  }

  /** L2 depth snapshot of the token's USDC spot book — same payload shape as perps. */
  async l2Snapshot(token: string): Promise<L2Snapshot> {
    const pair = await this.resolveSpotPair(token);
    const raw = await this.httpPost(`${this.baseUrl}/info`, { type: 'l2Book', coin: pair.coin });
    return parseHyperliquidL2(token, raw);
  }
}
