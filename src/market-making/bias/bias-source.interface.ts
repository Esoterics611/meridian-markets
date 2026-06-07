// IBiasSource — the directional "house view" seam for the axed market maker
// (DIRECTIONAL_MM_STRATEGY.md §4/§9). A neutral GLFT book mean-reverts inventory to
// ZERO, treating any held position as pure risk. The directional book instead rests
// at q* = bias·Q_max, turning the dominant inventory-carry P&L term from noise into a
// CHOSEN position. The bias b ∈ [−1,+1] IS that view.
//
// Because a blind bias is just a leveraged way to lose ("leverage on noise"), every
// reading carries a `validated` flag: until a source has passed its OOS forward-
// return gate it returns validated=false, and the runtime sizes NO carry from it
// (b→0). This makes the honesty gate part of the contract, not an afterthought.
//
// Same swap-seam discipline as every other input (CLAUDE.md §7): a NullBiasSource
// default (b=0 ⇒ identical to today's neutral GLFT, nothing regresses) plus concrete
// sources — FundingBiasSource (be long the funding-paid side), ManualBiasSource (the
// pre-run house-view override), and CompositeBiasSource (systematic default, house
// view overrides but is capped by the data). All pure + composable.

export interface BiasContext {
  /**
   * Signed perp funding rate per HOUR (+ ⇒ longs pay shorts, HL convention) — the
   * carry signal. 0/undefined on non-perp venues.
   */
  readonly fundingRatePerHour?: number;
  /** Recent per-bar (close-to-close) returns, oldest→newest, for a momentum read. */
  readonly recentReturns?: readonly number[];
  /** Current time (ms) — for decay/expiry of a time-stamped manual view. */
  readonly nowMs: number;
  /**
   * Signed top-N L2 book imbalance ∈ [−1,+1] (bid-heavy > 0). The fast microstructure
   * input for a flow-based directional source; undefined off the L2/fast path.
   */
  readonly bookImbalance?: number;
  /** Current fair-value mid (price micros) — lets a self-validating source score its
   *  own forward-return IC. Undefined off the L2/fast path. */
  readonly midMicros?: bigint;
}

export interface BiasReading {
  /** Target-inventory bias in [−1,+1]: +1 = max long, −1 = max short, 0 = neutral. */
  readonly bias: number;
  /**
   * OOS honesty gate: false ⇒ the runtime sizes NO carry from this reading (treats
   * the bias as 0). A source is validated only once it has shown a positive OOS
   * forward-return correlation — set explicitly, never assumed.
   */
  readonly validated: boolean;
  /** Short human reason for the tape / attribution (e.g. 'funding-paid short'). */
  readonly reason: string;
}

/** The neutral reading: no view, sizes no carry (and is trivially "validated"). */
export const NEUTRAL_BIAS: BiasReading = { bias: 0, validated: true, reason: 'neutral' };

export interface IBiasSource {
  /** The house view for a symbol given current context. b=0 ⇒ neutral MM. */
  bias(symbol: string, ctx: BiasContext): BiasReading;
}

/** Clamp a raw bias into the valid [−1, +1] band (NaN/∞ ⇒ 0). */
export function clampBias(b: number): number {
  if (!Number.isFinite(b)) return 0;
  return b < -1 ? -1 : b > 1 ? 1 : b;
}

/**
 * The effective bias the quoter should use: 0 unless the reading is validated. This
 * is THE enforcement point of the OOS gate — call it everywhere a reading becomes a
 * quote input so an unvalidated view can never size carry.
 */
export function effectiveBias(r: BiasReading): number {
  return r.validated ? clampBias(r.bias) : 0;
}
