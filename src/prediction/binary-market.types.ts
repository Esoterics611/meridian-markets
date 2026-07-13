/**
 * binary-market.types — the venue-agnostic shape of a tradeable price binary.
 *
 * Every prediction-market venue (HIP-4 today; Polymarket/Kalshi later) normalizes to
 * BinaryQuote: "pay $1 if <underlying> settles above <targetPrice> at <expiry>", with
 * an executable YES bid/ask in probability units. The RV book trades ONLY this shape —
 * price binaries on underlyings the desk can price off its own Deribit surface. Event
 * markets (elections, sports) have no model fair value here and are never traded.
 */

export interface PriceBinarySpec {
  /** Venue market id (HIP-4 outcome index as a string). */
  marketId: string;
  underlying: string;
  targetPrice: number;
  expiryMs: number;
  /** Recurrence tag from the venue, e.g. '1d'. */
  period: string;
}

export interface BinaryQuote extends PriceBinarySpec {
  venue: string;
  /** Best executable YES prices, probability units in [0,1]. */
  yesBid: number;
  yesAsk: number;
  /** Size at the touch, in contracts ($1 payout each). */
  yesBidSize: number;
  yesAskSize: number;
  timeMs: number;
}

export interface IBinaryMarketSource {
  venue: string;
  /** All live price binaries with a readable YES book. */
  listPriceBinaries(): Promise<BinaryQuote[]>;
  /** Venue mid for an underlying, used to settle expired binaries. */
  underlyingMid(underlying: string): Promise<number>;
}

/**
 * Parse a HIP-4 recurring price-binary description:
 *   'class:priceBinary|underlying:BTC|expiry:20260714-0600|targetPrice:62814|period:1d'
 * Returns null for anything that is not a well-formed price binary (event markets,
 * sports, etc. — those are deliberately untradeable for this desk).
 */
export function parsePriceBinaryDescription(
  desc: string,
): Omit<PriceBinarySpec, 'marketId'> | null {
  const fields = new Map<string, string>();
  for (const part of desc.split('|')) {
    const i = part.indexOf(':');
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  if (fields.get('class') !== 'priceBinary') return null;
  const underlying = fields.get('underlying');
  const expiry = fields.get('expiry');
  const target = Number(fields.get('targetPrice'));
  if (!underlying || !expiry || !Number.isFinite(target) || target <= 0) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(expiry);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const expiryMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return { underlying, targetPrice: target, expiryMs, period: fields.get('period') ?? '' };
}
