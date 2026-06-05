import { IQuoter } from './quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from './quote-pair';

// AvellanedaStoikovQuoter — the canonical inventory-aware quoter from AS08
// (course §3.3–§3.4). The two load-bearing formulas:
//
//   reservation price:  r(s,q,t) = s − q·γ·σ²·(T−t)
//   total spread:       δ_a + δ_b = γ·σ²·(T−t) + (2/γ)·ln(1 + γ/κ)
//
// The reservation price is where the maker is indifferent between holding q and
// holding zero: long inventory (q>0) pulls r *below* mid, so both quotes shift
// down and the next ask-fill (which sheds inventory) becomes likelier than the
// next bid-fill. That skew is the whole mechanism that steers the involuntary
// position back toward flat (course §1.3). The spread term has a vol/horizon
// piece (γσ²(T−t), the inventory-risk premium) and an arrival piece
// ((2/γ)ln(1+γ/κ), the order-processing premium).
//
// Units / scale-invariance (the load-bearing fix — Journal #17). σ is a per-bar
// RETURN FRACTION (ctx.volatility). The skew and half-spread are computed as
// **fractions of mid** off a fixed $1 reference scale (REF_MICROS) and then
// applied to the live mid — so a 4 bps/bar asset quotes the same *bps* spread at
// $1 or at $1,900. The earlier code multiplied σ by the live mid and squared it,
// so the inventory term scaled as price²: on a high-priced asset the skew blew the
// reservation to a nonsense price. At mid=$1 this formulation is numerically
// identical to the old one (the reference scale IS $1), so every spec is preserved.
// Inventory enters as *lots* (q = inventory ÷ quote size), clamped to
// ±maxInventoryLots; the skew fraction is further clamped to ±MAX_SKEW_FRAC so a
// high-vol asset can never push the quote negative, and the half-spread is railed
// to [min,max] bps of mid. γ, κ are free per-pair tuning (course §3.7); we
// unit-test direction + scale-invariance, not magnitude, as AS08 itself does.

export interface AvellanedaStoikovParams {
  gamma: number;
  kappa: number;
  quoteSizeUnits: bigint;
  /** One lot = this many asset units (normalises inventory). Defaults to quoteSizeUnits. */
  inventoryLotUnits?: bigint;
  /** Half-spread floor in bps of mid (venue tick / processing-cost floor). */
  minHalfSpreadBps: number;
  /** Half-spread cap in bps of mid (safety rail against a vol blow-up). */
  maxHalfSpreadBps: number;
  /** Saturation cap on |inventory| in lots. */
  maxInventoryLots: number;
}

// Fixed reference scale ($1 in micros): σ is squared at this scale, not the live
// mid, so skew/spread are price-scale-invariant fractions of mid. At mid=$1 the
// math is identical to the prior absolute formulation.
const REF_MICROS = 1_000_000;
/** Reservation skew is bounded to ±this fraction of mid, so a high-vol asset can
 *  never push the quote to a negative / nonsense price (γ tuning refines magnitude). */
export const MAX_SKEW_FRAC = 0.5;

/** AS08 reservation-price shift, in micros. σ is a per-bar RETURN FRACTION; the
 *  skew is a (clamped) fraction of mid → price-scale-invariant. */
export function asReservationMicros(midMicros: number, qLots: number, gamma: number, sigmaRel: number, horizonBars: number): number {
  const s = Math.max(sigmaRel, 0);
  const skewFrac = clamp(qLots * gamma * s * s * REF_MICROS * horizonBars, -MAX_SKEW_FRAC, MAX_SKEW_FRAC);
  return midMicros * (1 - skewFrac);
}

/** AS08 half-spread, in micros (one side). σ is a per-bar RETURN FRACTION; both the
 *  inventory-risk and arrival terms are fractions of mid → price-scale-invariant. */
export function asHalfSpreadMicros(midMicros: number, gamma: number, kappa: number, sigmaRel: number, horizonBars: number): number {
  const s = Math.max(sigmaRel, 0);
  const inventoryRiskFrac = gamma * s * s * REF_MICROS * horizonBars;
  const arrivalFrac = ((2 / gamma) * Math.log(1 + gamma / kappa)) / REF_MICROS;
  return (midMicros * (inventoryRiskFrac + arrivalFrac)) / 2;
}

export class AvellanedaStoikovQuoter implements IQuoter {
  readonly familyId = 'avellaneda-stoikov';
  private tickSeq = 0;
  private readonly lotUnits: bigint;

  constructor(
    private readonly p: AvellanedaStoikovParams,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.lotUnits = p.inventoryLotUnits && p.inventoryLotUnits > 0n ? p.inventoryLotUnits : p.quoteSizeUnits;
  }

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const s = Number(ctx.midMicros);
    // Quote center = fair value (micro-price) when supplied, else the raw mid.
    const center = Number(ctx.referenceMicros ?? ctx.midMicros);
    const sigmaRel = Math.max(ctx.volatility, 0);
    const qLots = clamp(Number(ctx.inventoryUnits) / Number(this.lotUnits), -this.p.maxInventoryLots, this.p.maxInventoryLots);
    const T = Math.max(ctx.horizonBars, 0);

    const reservation = asReservationMicros(center, qLots, this.p.gamma, sigmaRel, T);
    const halfRaw = asHalfSpreadMicros(s, this.p.gamma, this.p.kappa, sigmaRel, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const railed = railHalfSpread(halfRaw, minMicros, maxMicros);
    // F3: confidence-scaled spread (tighten when calm, widen when toxic), after the rails.
    const scale = ctx.spreadScale && ctx.spreadScale > 0 ? ctx.spreadScale : 1;
    const scaled = scale === 1 ? railed : BigInt(Math.round(Number(railed) * scale));
    const halfSpreadMicros = scaled > 1n ? scaled : 1n;

    return buildQuotePair({
      symbol,
      reservationMicros: BigInt(Math.round(reservation)),
      halfSpreadMicros,
      sizeUnits: this.p.quoteSizeUnits,
      ctx,
      strategyId: this.familyId,
      tickSeq: this.tickSeq++,
      clock: this.clock,
    });
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Round a float half-spread to micros and rail it to [min,max]. */
export function railHalfSpread(halfRawMicros: number, minMicros: bigint, maxMicros: bigint): bigint {
  let h = BigInt(Math.round(halfRawMicros));
  if (h < minMicros) h = minMicros;
  if (h > maxMicros) h = maxMicros;
  return h;
}
