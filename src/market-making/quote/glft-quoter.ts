import { IQuoter } from './quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from './quote-pair';
import { clamp, railHalfSpread, asReservationMicros, asHalfSpreadMicros } from './avellaneda-stoikov';

// GlftQuoter — the Guéant-Lehalle-Fernández-Tapia steady-state variant of
// Avellaneda-Stoikov (course §3.5). AS08 is a finite-horizon model: the
// inventory term carries a (T−t) that shrinks to zero at the terminal time, so
// a literal AS quoter stops skewing as its session clock runs out. A book that
// quotes *continuously*, with no meaningful terminal time, wants the
// infinite-horizon limit instead — GLFT replaces the (T−t) countdown with a
// constant steady-state horizon, giving an inventory skew and half-spread that
// don't decay as a session winds down.
//
// We implement that distinction directly: GLFT uses a fixed `steadyHorizonBars`
// for both the skew and the spread, *ignoring* ctx.horizonBars. The testable
// consequence — and the reason a continuous book prefers it — is that GLFT's
// quote is invariant to the horizon countdown while AS's collapses to the bare
// arrival spread as the horizon → 0. Same lot-normalised inventory and half-
// spread rails as AvellanedaStoikovQuoter.

export interface GlftQuoterParams {
  gamma: number;
  kappa: number;
  quoteSizeUnits: bigint;
  inventoryLotUnits?: bigint;
  /** Half-spread floor in bps of mid. */
  minHalfSpreadBps: number;
  /** Half-spread cap in bps of mid. */
  maxHalfSpreadBps: number;
  maxInventoryLots: number;
  /** Fixed steady-state horizon (bars) replacing AS's (T−t) countdown. */
  steadyHorizonBars: number;
  /** Multiplier on the inventory-SKEW term only (not the half-spread): pushes inventory
   *  back toward flat harder without widening the quote. The bare A-S skew is tiny at
   *  these σ (≈2 bps at full inventory) — too weak to mean-revert in a trend (Journal
   *  #39). 1 = standard A-S (legacy). Default 1. */
  inventorySkewMult?: number;
  /** Hard inventory backstop: when |inventory| ≥ maxInventoryLots, PARK the side that would
   *  ADD to the position at the max rail so the book physically cannot breach the cap,
   *  regardless of how weak the skew is. The fix for the runaway inventory that was the
   *  whole loss in Journal #39. Default false (skew-only — the legacy behaviour). */
  hardInventoryCap?: boolean;
  /** Cap inventory by NOTIONAL — a fraction of book capital at the LIVE mid — instead of a
   *  raw lot count. A fixed `maxInventoryLots` means a wildly different notional bet across a
   *  100×-price universe (4 lots of BTC ≫ 4 lots of DOGE), which is why BTC drew 10% on "4
   *  lots" in Journal #41. The effective cap each tick is
   *    effMaxLots = min(maxInventoryLots, frac·capitalUnits·1e6 / (midMicros·lotUnits))
   *  — the σ-scale-invariance lesson (S31) applied to the inventory cap. 0/undefined = off
   *  (legacy lot-count cap). Needs `capitalUnits`. */
  maxInventoryNotionalFrac?: number;
  /** Book capital in micro-USD (6-dec), for the notional inventory cap above. */
  capitalUnits?: bigint;
}

/** Floor a half-spread at 1 micro so a confidence-tightened quote never collapses to 0. */
function bigMax1(x: bigint): bigint {
  return x > 1n ? x : 1n;
}

export class GlftQuoter implements IQuoter {
  readonly familyId = 'glft';
  private tickSeq = 0;
  private readonly lotUnits: bigint;

  constructor(
    private readonly p: GlftQuoterParams,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.lotUnits = p.inventoryLotUnits && p.inventoryLotUnits > 0n ? p.inventoryLotUnits : p.quoteSizeUnits;
  }

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const s = Number(ctx.midMicros);
    // Quote center = the supplied fair value (micro-price) when present, else the
    // raw mid. Only the reservation center moves; spread width + rails stay scaled
    // off the mid (so the spread is unchanged — we quote a better PRICE, not wider).
    const center = Number(ctx.referenceMicros ?? ctx.midMicros);
    const sigmaRel = Math.max(ctx.volatility, 0);
    const rawQLots = Number(ctx.inventoryUnits) / Number(this.lotUnits);
    // Notional inventory cap (Journal #41): convert a capital-fraction notional budget into an
    // effective lot cap at the live mid, so the bound is the SAME risk across a 100×-price
    // universe instead of the same lot count. Falls back to the raw lot cap when unset/unusable.
    const effMaxLots = this.effectiveMaxLots(s);
    const qLots = clamp(rawQLots, -effMaxLots, effMaxLots);
    const skewMult = this.p.inventorySkewMult && this.p.inventorySkewMult > 0 ? this.p.inventorySkewMult : 1;
    const T = this.p.steadyHorizonBars; // steady-state: NOT ctx.horizonBars

    // Same price-scale-invariant skew/spread as AS, with the steady-state horizon. The
    // skew term is multiplied by inventorySkewMult so it actually mean-reverts (Journal #39).
    const reservation = asReservationMicros(center, qLots * skewMult, this.p.gamma, sigmaRel, T);
    const halfRaw = asHalfSpreadMicros(s, this.p.gamma, this.p.kappa, sigmaRel, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const railed = railHalfSpread(halfRaw, minMicros, maxMicros);
    // F3: confidence-scaled spread (tighten when calm, widen when toxic). Applied AFTER
    // the rails so a confident book can quote inside the floor; hard min 1 micro.
    const scale = ctx.spreadScale && ctx.spreadScale > 0 ? ctx.spreadScale : 1;
    const halfSpreadMicros = scale === 1 ? railed : bigMax1(BigInt(Math.round(Number(railed) * scale)));

    // Hard inventory cap (backstop): at/over the cap, park the side that would ADD to the
    // position at the max rail so the book cannot breach maxInventoryLots. The other side
    // keeps quoting (already skewed toward flat) so the position still sheds.
    let bidHalfSpreadMicros: bigint | undefined;
    let askHalfSpreadMicros: bigint | undefined;
    if (this.p.hardInventoryCap) {
      if (rawQLots >= effMaxLots) bidHalfSpreadMicros = maxMicros; // at notional/lot cap long ⇒ stop buying
      else if (rawQLots <= -effMaxLots) askHalfSpreadMicros = maxMicros; // at cap short ⇒ stop selling
    }

    return buildQuotePair({
      symbol,
      reservationMicros: BigInt(Math.round(reservation)),
      halfSpreadMicros,
      bidHalfSpreadMicros,
      askHalfSpreadMicros,
      sizeUnits: this.p.quoteSizeUnits,
      ctx,
      strategyId: this.familyId,
      tickSeq: this.tickSeq++,
      clock: this.clock,
    });
  }

  /** Effective inventory cap in lots. When a notional fraction + capital are configured, the
   *  cap is the SMALLER of the raw lot cap and the capital-fraction notional budget at the
   *  live mid `s` (= midMicros = price·1e6). notional_microUSD(lots) = lots·lotUnits·s/1e6, so
   *  the lot budget for frac·capitalUnits is frac·capitalUnits·1e6/(s·lotUnits) — the same
   *  unit convention as quoteUnitsForNotional. Off by default ⇒ the legacy lot-count cap. */
  private effectiveMaxLots(s: number): number {
    const frac = this.p.maxInventoryNotionalFrac;
    const cap = this.p.capitalUnits;
    if (!frac || frac <= 0 || !cap || cap <= 0n || !(s > 0)) return this.p.maxInventoryLots;
    const notionalCapLots = (frac * Number(cap) * 1_000_000) / (s * Number(this.lotUnits));
    if (!Number.isFinite(notionalCapLots) || notionalCapLots <= 0) return this.p.maxInventoryLots;
    return Math.min(this.p.maxInventoryLots, notionalCapLots);
  }
}
