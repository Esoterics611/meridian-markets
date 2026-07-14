/**
 * implied-digital — risk-neutral binary (digital) prices off the fitted vol smile.
 *
 * The desk's fair value for any "P(S_T > K)" claim (HIP-4 price binaries, Polymarket
 * crypto dailies, Kalshi ranges) is the option-implied digital:
 *
 *   naive:         P(S_T > K) = N(d2)                       (flat-vol digital)
 *   smile-adjusted: −dC/dK   = N(d2) − vega(K)·(dσ/dK)      (the real RND tail)
 *
 * The skew term matters: with an upward-sloping call wing (dσ/dK > 0) the naive
 * N(d2) OVERSTATES the true probability of finishing above K. On the 2026-07-13
 * live read (BTC 11.9h daily) the correction was −0.9 prob-points on a 14-point
 * digital — bigger than most crowd-vs-fair gaps, so it is not optional.
 *
 * Pure functions, no I/O. Vol points come from any source (DeribitDigitalSource
 * feeds them live; specs feed them fixed).
 */
import { normCdf, normPdf } from '../greeks/black-scholes';

export interface VolPoint {
  strike: number;
  /** Implied vol as a fraction (0.35 = 35%). */
  iv: number;
}

export interface DigitalInputs {
  spot: number;
  strike: number;
  /** Year-fraction to the BINARY's expiry (not the option's, if they differ). */
  tYears: number;
  /** Interpolated IV at the binary strike. */
  iv: number;
  /** Local smile slope dσ/dK at the strike, per $1 of strike. 0 ⇒ naive digital. */
  skewPerDollar?: number;
  /** Risk-free rate fraction; crypto convention 0. */
  rate?: number;
}

export interface DigitalPrice {
  /** Flat-vol N(d2). */
  naive: number;
  /** Smile-adjusted −dC/dK, clamped to [0, 1]. THE fair value. */
  smileAdjusted: number;
  d2: number;
}

/** Risk-neutral P(S_T > K) with optional smile adjustment. */
export function impliedDigital(p: DigitalInputs): DigitalPrice {
  const { spot: S, strike: K, tYears: T, iv: sigma } = p;
  const r = p.rate ?? 0;
  const skew = p.skewPerDollar ?? 0;

  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const settled = S > K ? 1 : 0;
    return { naive: settled, smileAdjusted: settled, d2: S > K ? Infinity : -Infinity };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const naive = normCdf(d2);
  // vega per 1.00 vol at strike K; digital = N(d2) − vega·dσ/dK (undiscounted, r≈0 crypto).
  const vega = S * normPdf(d1) * sqrtT;
  const smileAdjusted = Math.min(1, Math.max(0, naive - vega * skew));
  return { naive, smileAdjusted, d2 };
}

export interface IvAtStrike {
  iv: number;
  skewPerDollar: number;
}

/**
 * Linear IV interpolation at `strike` from the two bracketing smile points, with the
 * local slope as the skew. Outside the quoted range: clamp to the nearest point's IV
 * and use the nearest segment's slope (extrapolating IV linearly far outside a thin
 * daily chain invents vol — clamping is the conservative choice for a fair value).
 * Throws on fewer than 2 points — a one-point "smile" cannot price a skewed digital.
 */
export function ivAtStrike(points: VolPoint[], strike: number): IvAtStrike {
  if (points.length < 2) throw new Error(`ivAtStrike needs ≥2 vol points, got ${points.length}`);
  const ps = [...points].sort((a, b) => a.strike - b.strike);
  let lo = ps[0];
  let hi = ps[ps.length - 1];
  for (let i = 0; i + 1 < ps.length; i++) {
    if (strike >= ps[i].strike && strike <= ps[i + 1].strike) {
      lo = ps[i];
      hi = ps[i + 1];
      break;
    }
  }
  const slope = (hi.iv - lo.iv) / (hi.strike - lo.strike);
  if (strike <= ps[0].strike) return { iv: ps[0].iv, skewPerDollar: (ps[1].iv - ps[0].iv) / (ps[1].strike - ps[0].strike) };
  if (strike >= ps[ps.length - 1].strike) {
    const a = ps[ps.length - 2];
    const b = ps[ps.length - 1];
    return { iv: b.iv, skewPerDollar: (b.iv - a.iv) / (b.strike - a.strike) };
  }
  return { iv: lo.iv + slope * (strike - lo.strike), skewPerDollar: slope };
}
