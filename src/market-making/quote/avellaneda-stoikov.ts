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
// Units / risk-unit choice. σ is a per-bar fraction of price, so the price
// stdev is σ_price = σ·s in micros. Inventory enters as *lots* — q = inventory
// ÷ quote size — not raw asset count, so a one-sided fill is q=1 regardless of
// how big a quote is; the skew is "how many quote-sizes am I imbalanced," the
// natural risk unit. q is clamped to ±maxInventoryLots and the half-spread is
// railed to [min,max] micros, so even a volatile tape can't produce an absurd
// quote. γ, κ are free per-pair tuning (course §3.7 sweep-then-pick), surfaced
// in the registry; we unit-test direction, not magnitude, as AS08 itself does.

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

/** AS08 reservation-price shift, in micros. qLots is signed inventory in lots. */
export function asReservationMicros(midMicros: number, qLots: number, gamma: number, sigmaPriceMicros: number, horizonBars: number): number {
  const skew = qLots * gamma * sigmaPriceMicros * sigmaPriceMicros * horizonBars;
  return midMicros - skew;
}

/** AS08 half-spread, in micros (one side). */
export function asHalfSpreadMicros(gamma: number, kappa: number, sigmaPriceMicros: number, horizonBars: number): number {
  const inventoryRisk = gamma * sigmaPriceMicros * sigmaPriceMicros * horizonBars;
  const arrival = (2 / gamma) * Math.log(1 + gamma / kappa);
  return (inventoryRisk + arrival) / 2;
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
    const sigmaPrice = Math.max(ctx.volatility, 0) * s;
    const qLots = clamp(Number(ctx.inventoryUnits) / Number(this.lotUnits), -this.p.maxInventoryLots, this.p.maxInventoryLots);
    const T = Math.max(ctx.horizonBars, 0);

    const reservation = asReservationMicros(s, qLots, this.p.gamma, sigmaPrice, T);
    const halfRaw = asHalfSpreadMicros(this.p.gamma, this.p.kappa, sigmaPrice, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const halfSpreadMicros = railHalfSpread(halfRaw, minMicros, maxMicros);

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
