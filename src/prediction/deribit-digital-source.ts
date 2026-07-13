/**
 * deribit-digital-source — the desk's fair value for a price binary, live.
 *
 * Fetches the Deribit option chain (cached), picks the expiry that covers the binary,
 * interpolates IV at the binary's strike from the CALL smile, and prices the digital
 * smile-adjusted (implied-digital.ts). Honesty notes, on purpose:
 *   - Tenor mismatch: HIP-4 dailies settle 06:00 UTC, Deribit dailies 08:00 UTC. We use
 *     the binary's OWN T with the option expiry's smile — a flat-forward-vol assumption
 *     over the 2h gap. Documented, small at daily tenor, not zero.
 *   - Resolution-source mismatch: the binary settles on the venue's oracle, the smile is
 *     struck on Deribit's index. Same-underlying guard (±5%, the #92 lesson) refuses to
 *     price if the two spots disagree materially.
 */
import { DeribitClient, DeribitOption } from '../derivatives/deribit/deribit-client';
import { impliedDigital, ivAtStrike, VolPoint } from '../derivatives/rnd/implied-digital';

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
/** Max option-expiry overhang past the binary expiry before we refuse (26h ≈ next daily). */
const MAX_EXPIRY_GAP_MS = 26 * 3600 * 1000;
/** #92 ticker-collision lesson, applied to spots: venue vs Deribit index tolerance. */
export const MAX_SPOT_DISAGREE_FRAC = 0.05;

export interface FairDigital {
  /** Smile-adjusted P(S_T > K) — THE fair value. */
  fairYes: number;
  naive: number;
  iv: number;
  skewPerDollar: number;
  deribitSpot: number;
  optionExpiryMs: number;
  nPoints: number;
}

export class DeribitDigitalSource {
  private cache = new Map<string, { atMs: number; chain: DeribitOption[] }>();

  constructor(
    private readonly client: DeribitClient,
    private readonly chainTtlMs = 60_000,
  ) {}

  /**
   * Fair YES probability for "underlying > targetPrice at expiryMs", or null with a
   * reason when the desk cannot honestly price it (no covering expiry, thin smile,
   * spot disagreement). Callers must treat null as NO TRADE, never as 0.5.
   */
  async fairYes(
    underlying: string,
    targetPrice: number,
    expiryMs: number,
    nowMs: number,
    venueSpot?: number,
  ): Promise<{ fair: FairDigital | null; reason?: string }> {
    const ccy = underlying.toUpperCase();
    const chain = await this.chainFor(ccy, nowMs);
    const calls = chain.filter((o) => o.type === 'CALL' && o.markIv > 0 && o.expiryMs >= expiryMs);
    if (calls.length === 0) return { fair: null, reason: `no ${ccy} option expiry ≥ binary expiry` };
    const optionExpiryMs = Math.min(...calls.map((o) => o.expiryMs));
    if (optionExpiryMs - expiryMs > MAX_EXPIRY_GAP_MS) {
      return { fair: null, reason: `nearest option expiry ${((optionExpiryMs - expiryMs) / 3.6e6).toFixed(1)}h past binary — too far` };
    }
    const smile = calls.filter((o) => o.expiryMs === optionExpiryMs);
    if (smile.length < 2) return { fair: null, reason: `only ${smile.length} smile point(s) at expiry` };

    const points: VolPoint[] = smile
      .map((o) => ({ strike: o.strike, iv: o.markIv }))
      .sort((a, b) => a.strike - b.strike);
    const spot = median(smile.map((o) => o.underlyingPrice));
    if (venueSpot != null && Math.abs(venueSpot - spot) / spot > MAX_SPOT_DISAGREE_FRAC) {
      return { fair: null, reason: `venue spot ${venueSpot} vs Deribit ${spot.toFixed(0)} disagree >±${MAX_SPOT_DISAGREE_FRAC * 100}% — #92 guard` };
    }

    const tYears = (expiryMs - nowMs) / YEAR_MS;
    if (tYears <= 0) return { fair: null, reason: 'binary already expired' };
    const { iv, skewPerDollar } = ivAtStrike(points, targetPrice);
    const d = impliedDigital({ spot, strike: targetPrice, tYears, iv, skewPerDollar });
    return {
      fair: {
        fairYes: d.smileAdjusted,
        naive: d.naive,
        iv,
        skewPerDollar,
        deribitSpot: spot,
        optionExpiryMs,
        nPoints: points.length,
      },
    };
  }

  private async chainFor(ccy: string, nowMs: number): Promise<DeribitOption[]> {
    const hit = this.cache.get(ccy);
    if (hit && nowMs - hit.atMs < this.chainTtlMs) return hit.chain;
    const chain = await this.client.optionChain(ccy);
    this.cache.set(ccy, { atMs: nowMs, chain });
    return chain;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
