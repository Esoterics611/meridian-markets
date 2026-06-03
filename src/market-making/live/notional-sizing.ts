// Notional sizing — turn a DOLLAR quote size into asset units at the live price.
// The MM control plane historically sized every book at a fixed `quoteSizeUnits`
// (raw 6-decimal ASSET units), which is ≈ dollars only for a ~$1 stablecoin. On a
// $66k perp that same unit count is a ~66,000× over-size; on a $0.001 token it is a
// dust quote. Sizing by $ notional ÷ price fixes both: a $50k quote is $50k of the
// asset whatever its price — the same lever the session/tuning harnesses already use
// (MM_SESSION_QUOTE_USD / MM_L2_QUOTE_USD), now available to /api/market-making/launch.

const MICROS = 1_000_000;

/**
 * Asset units (6-dec) for a $ notional at `price`. Falls back to `fallbackUnits`
 * when the notional or price is unusable (≤0 / non-finite) — so an un-priced or
 * mock book keeps its old fixed-unit behaviour rather than sizing to zero.
 */
export function quoteUnitsForNotional(notionalUsd: number, price: number, fallbackUnits: bigint): bigint {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return fallbackUnits;
  if (!Number.isFinite(price) || price <= 0) return fallbackUnits;
  return BigInt(Math.max(1, Math.round((notionalUsd / price) * MICROS)));
}
