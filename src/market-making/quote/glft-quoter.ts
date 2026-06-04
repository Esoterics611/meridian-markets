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
    const qLots = clamp(Number(ctx.inventoryUnits) / Number(this.lotUnits), -this.p.maxInventoryLots, this.p.maxInventoryLots);
    const T = this.p.steadyHorizonBars; // steady-state: NOT ctx.horizonBars

    // Same price-scale-invariant skew/spread as AS, with the steady-state horizon.
    const reservation = asReservationMicros(center, qLots, this.p.gamma, sigmaRel, T);
    const halfRaw = asHalfSpreadMicros(s, this.p.gamma, this.p.kappa, sigmaRel, T);
    const minMicros = BigInt(Math.round((s * this.p.minHalfSpreadBps) / 10_000));
    const maxMicros = BigInt(Math.round((s * this.p.maxHalfSpreadBps) / 10_000));
    const railed = railHalfSpread(halfRaw, minMicros, maxMicros);
    // F3: confidence-scaled spread (tighten when calm, widen when toxic). Applied AFTER
    // the rails so a confident book can quote inside the floor; hard min 1 micro.
    const scale = ctx.spreadScale && ctx.spreadScale > 0 ? ctx.spreadScale : 1;
    const halfSpreadMicros = scale === 1 ? railed : bigMax1(BigInt(Math.round(Number(railed) * scale)));

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
