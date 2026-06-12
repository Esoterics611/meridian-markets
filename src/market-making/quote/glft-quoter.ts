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
  /** σ-INDEPENDENT inventory lean (Journal #48). The reservation skew above is ∝ γ·σ²·q, so in a
   *  CALM-but-trending tape (low realised vol, steady drift) it nearly vanishes and the book keeps
   *  accumulating one-sided inventory that marks against it. This adds a graduated ASYMMETRIC
   *  half-spread skew driven by inventory UTILISATION u = q/cap ∈ [−1,1]: TIGHTEN the side that
   *  sheds (more fills exiting) and WIDEN the side that adds (fewer fills building), proportional to
   *  how full the book is — so it leans HARDER against the trend the more inventory it carries,
   *  regardless of σ. Ramps smoothly to the hard cap. 0 = off (legacy). Typical 0.3–0.5. */
  inventorySpreadSkew?: number;
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

  // ── F3 concentration controls (Journal #62; run55: ADA −138 warehouse at 94% conc) ──
  /** Soft concentration band start: conc = |q|/effMaxLots above this begins the ramp.
   *  0/undefined = F3 off (legacy behaviour). Typical 0.5. */
  concSoftFrac?: number;
  /** Hard concentration cap: conc ≥ this ⇒ the ADDING side is not quoted at all
   *  (reduce-only). Must be > concSoftFrac. Typical 0.85. */
  concHardFrac?: number;
  /** Extra reservation-skew gain at full ramp: effSkewMult = inventorySkewMult·(1 + gain·r),
   *  r ∈ [0,1] over [soft, hard]. 0 = sizes-only ramp. Typical 2. */
  concSkewGain?: number;
  /** Change-driven observability (PART V): fired when the concentration ZONE changes
   *  (free → ramp → reduce-only and back), with the triggering numbers. The module wires
   *  this to a CONTROL ▸/BLOCKED ▸ log line + tape event. */
  onInventoryControl?: (st: InventoryControlState) => void;
}

/** The F3 concentration-control state, emitted on zone change (PART V observability). */
export interface InventoryControlState {
  symbol: string;
  zone: 'free' | 'ramp' | 'reduce-only';
  /** Signed inventory in lots and the concentration |q|/effMaxLots it implies. */
  qLots: number;
  conc: number;
  /** The side being throttled ('bid' when long — buys add; 'ask' when short). */
  addingSide: 'bid' | 'ask';
  /** Fraction of full size still quoted on the adding side (0 in reduce-only). */
  addSizeFrac: number;
  /** The effective reservation-skew multiplier after the concentration gain. */
  effSkewMult: number;
  sigma: number;
}

/** Floor a half-spread at 1 micro so a confidence-tightened quote never collapses to 0. */
function bigMax1(x: bigint): bigint {
  return x > 1n ? x : 1n;
}

export class GlftQuoter implements IQuoter {
  readonly familyId = 'glft';
  private tickSeq = 0;
  private readonly lotUnits: bigint;
  /** Last emitted F3 concentration zone, for change-driven control events. */
  private lastConcZone: InventoryControlState['zone'] = 'free';

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

    // F3 concentration ramp (Journal #62): conc = |q|/cap; past the SOFT band, ramp r ∈ [0,1]
    // strengthens the reservation skew (effSkewMult) and CUTS the adding side's size, reaching
    // reduce-only (adding size 0) at the HARD cap — one-sided accumulation was the run55
    // warehouse leak (ADA −138 at 94% conc; DOGE balanced at 20% was net-positive). κ stays 0
    // here: the flow term is F4's, this control is inventory-only.
    const soft = this.p.concSoftFrac ?? 0;
    const hard = Math.max(this.p.concHardFrac ?? 1, soft + 1e-9);
    const conc = effMaxLots > 0 ? Math.abs(rawQLots) / effMaxLots : 0;
    const ramp = soft > 0 ? clamp((conc - soft) / (hard - soft), 0, 1) : 0;
    const effSkewMult = skewMult * (1 + (this.p.concSkewGain ?? 0) * ramp);
    const addingSide: 'bid' | 'ask' = rawQLots >= 0 ? 'bid' : 'ask';
    const addSizeFrac = soft > 0 ? 1 - ramp : 1;
    if (this.p.onInventoryControl && soft > 0) {
      const zone: InventoryControlState['zone'] = ramp >= 1 ? 'reduce-only' : ramp > 0 ? 'ramp' : 'free';
      if (zone !== this.lastConcZone) {
        this.lastConcZone = zone;
        try {
          this.p.onInventoryControl({ symbol, zone, qLots: rawQLots, conc, addingSide, addSizeFrac, effSkewMult, sigma: sigmaRel });
        } catch {
          /* observability must never break the quote path */
        }
      }
    }

    // Same price-scale-invariant skew/spread as AS, with the steady-state horizon. The
    // skew term is multiplied by inventorySkewMult (× the F3 concentration gain) so it
    // actually mean-reverts (Journal #39 / #62).
    const reservation = asReservationMicros(center, qLots * effSkewMult, this.p.gamma, sigmaRel, T);
    const halfRaw = asHalfSpreadMicros(s, this.p.gamma, this.p.kappa, sigmaRel, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const railed = railHalfSpread(halfRaw, minMicros, maxMicros);
    // F3: confidence-scaled spread (tighten when calm, widen when toxic). Applied AFTER
    // the rails so a confident book can quote inside the floor; hard min 1 micro.
    const scale = ctx.spreadScale && ctx.spreadScale > 0 ? ctx.spreadScale : 1;
    const halfSpreadMicros = scale === 1 ? railed : bigMax1(BigInt(Math.round(Number(railed) * scale)));

    let bidHalfSpreadMicros: bigint | undefined;
    let askHalfSpreadMicros: bigint | undefined;

    // σ-independent inventory lean (Journal #48): tighten the SHEDDING side + widen the ADDING side
    // proportional to inventory utilisation u, so the book actively reduces inventory even in a calm
    // trend where the σ²-scaled reservation skew above is too weak. u>0 (net long) ⇒ widen bid (buy
    // less), tighten ask (sell more); u<0 flips. bigMax1 keeps the tightened side ≥ 1 micro.
    const shed = this.p.inventorySpreadSkew && this.p.inventorySpreadSkew > 0 ? this.p.inventorySpreadSkew : 0;
    if (shed > 0 && effMaxLots > 0) {
      const u = clamp(rawQLots / effMaxLots, -1, 1);
      bidHalfSpreadMicros = bigMax1(BigInt(Math.round(Number(halfSpreadMicros) * (1 + shed * u))));
      askHalfSpreadMicros = bigMax1(BigInt(Math.round(Number(halfSpreadMicros) * (1 - shed * u))));
    }

    // Hard inventory cap (backstop): at/over the cap, park the side that would ADD to the
    // position at the max rail so the book cannot breach maxInventoryLots. Overrides the lean
    // above on the adding side; the shedding side keeps its tightened quote so the book still sheds.
    if (this.p.hardInventoryCap) {
      if (rawQLots >= effMaxLots) bidHalfSpreadMicros = maxMicros; // at notional/lot cap long ⇒ stop buying
      else if (rawQLots <= -effMaxLots) askHalfSpreadMicros = maxMicros; // at cap short ⇒ stop selling
    }

    // F3: cut the ADDING side's size along the ramp; 0 at the hard cap ⇒ that side is not
    // quoted (reduce-only). The reducing side keeps full size (we WANT those fills).
    const addSize = addSizeFrac >= 1 ? this.p.quoteSizeUnits : BigInt(Math.round(Number(this.p.quoteSizeUnits) * addSizeFrac));
    return buildQuotePair({
      symbol,
      reservationMicros: BigInt(Math.round(reservation)),
      halfSpreadMicros,
      bidHalfSpreadMicros,
      askHalfSpreadMicros,
      sizeUnits: this.p.quoteSizeUnits,
      bidSizeUnits: addingSide === 'bid' ? addSize : undefined,
      askSizeUnits: addingSide === 'ask' ? addSize : undefined,
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
