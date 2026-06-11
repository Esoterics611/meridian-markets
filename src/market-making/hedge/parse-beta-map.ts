import { BetaMapEntry } from './desk-delta-hedger';
import { hlCoin } from '../../market-data/reference/hyperliquid-trades';

/**
 * Parse `MM_HEDGE_BETA_MAP` — fold book symbols onto a hedge underlying with a beta so a few
 * major-perp legs neutralise the whole basket's net delta (Journal #41: "8 neutral books = ONE
 * crypto-beta bet"; #44 DR-3: the hard-coded empty map left that bet unhedged).
 *
 * Format: comma-separated `SYMBOL:UNDERLYING:BETA` triples, e.g.
 *   "SOL:BTC:1.4,ETH:BTC:1.2,DOGE:BTC:1.6"
 * maps the SOL/ETH/DOGE book deltas onto a single BTC perp at the given betas (long-SOL nets
 * against short-ETH in BTC-equivalent terms ⇒ a smaller, capital-efficient aggregate hedge).
 *
 * Symbols NOT listed self-hedge per-symbol (underlying = the symbol, beta 1) — see
 * `netDeltaByUnderlying`. An empty/blank string therefore returns `{}` = the EXPLICIT,
 * documented self-hedge default (every book hedges its own perp 1:1), not a hidden no-op.
 *
 * Beta 0 is the EXPLICIT "do not hedge this book" marker (the inventory governor caps it
 * instead). It exists for books with no crypto factor — a HIP-3 RWA like "xyz:GOLD" must not
 * inherit the self-hedge default (paying taker to flatten its own perp) nor a crypto beta.
 *
 * HIP-3 symbols contain ':' (the dex prefix), which collides with the triple separator — so
 * entries parse RIGHT-anchored: the last two segments are UNDERLYING and BETA, everything
 * before them is the symbol ("xyz:GOLD:xyz:GOLD:0" won't arise; "xyz:GOLD:GOLD:0" ⇒ symbol
 * "xyz:GOLD"). Symbols/underlyings normalise with hlCoin (HIP-3 coin keys are exact-case).
 *
 * Malformed entries are skipped (a bad env string must never crash the desk); pass `onWarn`
 * to surface them at boot.
 */
export function parseHedgeBetaMap(
  raw: string,
  onWarn?: (msg: string) => void,
): Record<string, BetaMapEntry> {
  const out: Record<string, BetaMapEntry> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    // Pipe form `SYMBOL|UNDERLYING|BETA` is the unambiguous spelling for entries where the
    // UNDERLYING itself contains ':' (xyz:CL|xyz:BRENTOIL|1.08 — the right-anchored colon
    // parse mis-grouped that as symbol "xyz:CL:xyz"; Journal #57 run54 boot bug).
    const segs = (part.includes('|') ? part.split('|') : part.split(':')).map((s) => s.trim());
    const sym = segs.slice(0, -2).join(':');
    const underlying = segs[segs.length - 2];
    const betaStr = segs[segs.length - 1];
    const beta = Number(betaStr);
    if (segs.length < 3 || !sym || !underlying || !betaStr || !Number.isFinite(beta) || beta < 0) {
      onWarn?.(`MM_HEDGE_BETA_MAP: skipping malformed entry "${part}" (want SYMBOL:UNDERLYING:BETA with beta≥0; beta 0 = don't hedge)`);
      continue;
    }
    out[hlCoin(sym)] = { underlying: hlCoin(underlying), beta };
  }
  return out;
}

/** Human-readable one-liner for the boot log, so the effective hedge target is never hidden. */
export function describeBetaMap(map: Record<string, BetaMapEntry>): string {
  const entries = Object.entries(map);
  if (!entries.length) return 'self-hedge per-symbol (beta 1)';
  return entries.map(([s, e]) => `${s}→${e.underlying}×${e.beta}`).join(', ');
}
