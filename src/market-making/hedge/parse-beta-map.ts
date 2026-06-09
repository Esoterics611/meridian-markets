import { BetaMapEntry } from './desk-delta-hedger';

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
 * Malformed entries are skipped (a bad env string must never crash the desk); pass `onWarn`
 * to surface them at boot.
 */
export function parseHedgeBetaMap(
  raw: string,
  onWarn?: (msg: string) => void,
): Record<string, BetaMapEntry> {
  const out: Record<string, BetaMapEntry> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [sym, underlying, betaStr] = part.split(':').map((s) => s.trim());
    const beta = Number(betaStr);
    if (!sym || !underlying || !betaStr || !Number.isFinite(beta) || beta <= 0) {
      onWarn?.(`MM_HEDGE_BETA_MAP: skipping malformed entry "${part}" (want SYMBOL:UNDERLYING:BETA with beta>0)`);
      continue;
    }
    out[sym.toUpperCase()] = { underlying: underlying.toUpperCase(), beta };
  }
  return out;
}

/** Human-readable one-liner for the boot log, so the effective hedge target is never hidden. */
export function describeBetaMap(map: Record<string, BetaMapEntry>): string {
  const entries = Object.entries(map);
  if (!entries.length) return 'self-hedge per-symbol (beta 1)';
  return entries.map(([s, e]) => `${s}→${e.underlying}×${e.beta}`).join(', ');
}
