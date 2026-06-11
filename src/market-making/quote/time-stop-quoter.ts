import { IQuoter } from './quoter.interface';
import { QuoteContext, QuotePair } from './quote-pair';

// TimeStopQuoter — the S2 inventory TIME-STOP (MASTER PLAN I; Journal #52 motivation).
//
// S1's leak tables showed the desk's #1 leak class is WAREHOUSE MTM: the governor caps how BIG
// a position gets, but nothing bounds how LONG it is held — a capped position riding a trend is
// the loss (#51: BRENTOIL −$1,128 / HYPE −$1,126 warehouse vs fill edges of −277/−373; A″'s
// ETH/BTC had POSITIVE fill edge and still bled −355/−263 warehouse).
//
// Design: a WRAPPER around any IQuoter (replay and live see the identical object — the engine's
// swap-seam discipline). It tracks how long the book has been carrying a same-signed, non-trivial
// inventory using ctx.nowMs (set by all three runtimes). Once the age exceeds `ageMs`, it shifts
// the WHOLE quote pair toward the exit side, ramping linearly to `maxShiftBps` over `rampMs`:
// long inventory ⇒ both quotes shift DOWN (the ask gets aggressive and sells the position out,
// the bid backs away from adding); short ⇒ up. Width is preserved — this is skew-to-flat
// escalation, not a spread change, so the rebate economics of the exit fill are unchanged.
//
// This is the doctrine's "get out aggressively" applied to MM inventory (risk doctrine #4 +
// "fewer fills over losing fills"): it deliberately trades entry fills for exits while aged.
// A TAKER exit variant (pay the spread to flatten NOW) is intentionally NOT here — it needs a
// venue order path, and the replay sweep must first prove the passive escalation insufficient.
//
// The age clock RESETS when: inventory is inside the flat band, the sign flips, or nowMs is
// unavailable (a runtime that can't measure time gets the inner quoter unchanged — dormant).

export interface TimeStopParams {
  /** Holding age (ms) at which the stop engages. */
  ageMs: number;
  /** Linear ramp: full `maxShiftBps` is reached at ageMs + rampMs. */
  rampMs: number;
  /** Max shift of the quote pair toward the exit side, in bps of mid. */
  maxShiftBps: number;
  /** |inventory| at or below this (asset units) counts as flat and re-anchors the clock. */
  flatUnits: bigint;
  /**
   * Proportional control (no-overshoot): |inventory| at which the shift reaches full strength;
   * below it the shift scales linearly with |inv|, so the push FADES as the book approaches flat
   * instead of swinging it through zero into the opposite warehouse (the first sweep's defect:
   * BTC went +$103k long → −$68k short under a constant-strength stop). Omit ⇒ constant strength.
   */
  fullUnits?: bigint;
  /** Observer for state transitions (the live module wires this to the desk-event tape). */
  onChange?: (s: { active: boolean; ageMs: number; shiftBps: number }) => void;
}

export class TimeStopQuoter implements IQuoter {
  readonly familyId: string;
  private anchorMs: number | null = null;
  private lastSign: -1 | 0 | 1 = 0;
  private wasActive = false;

  constructor(
    private readonly inner: IQuoter,
    private readonly p: TimeStopParams,
  ) {
    this.familyId = inner.familyId; // invisible to attribution/UI — same family, same book
  }

  /** Exposed for the runtime's snapshot/diagnostics. */
  state(): { active: boolean; ageMs: number } {
    return { active: this.wasActive, ageMs: this.anchorMs === null ? 0 : this.lastAge };
  }
  private lastAge = 0;

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const q = this.inner.quote(ctx, symbol);
    const inv = ctx.inventoryUnits;
    const sign: -1 | 0 | 1 = inv > this.p.flatUnits ? 1 : inv < -this.p.flatUnits ? -1 : 0;
    const now = ctx.nowMs;

    if (now === undefined || sign === 0 || sign !== this.lastSign) {
      // flat, sign flip, or no clock ⇒ re-anchor; the stop is dormant this tick.
      this.anchorMs = now ?? null;
      this.lastSign = sign;
      this.deactivate();
      return q;
    }
    if (this.anchorMs === null) this.anchorMs = now;
    const age = now - this.anchorMs;
    this.lastAge = age;
    if (age <= this.p.ageMs) {
      this.deactivate();
      return q;
    }

    const frac = Math.min(1, (age - this.p.ageMs) / Math.max(1, this.p.rampMs));
    const sizeFrac = this.p.fullUnits
      ? Math.min(1, Number(inv < 0n ? -inv : inv) / Number(this.p.fullUnits))
      : 1;
    const shiftBps = this.p.maxShiftBps * frac * sizeFrac;
    // long ⇒ shift down (sell out); short ⇒ shift up (buy back).
    const shift = BigInt(Math.round((Number(ctx.midMicros) * shiftBps) / 10_000)) * BigInt(-sign);
    if (!this.wasActive) {
      this.wasActive = true;
      this.p.onChange?.({ active: true, ageMs: age, shiftBps });
    }
    const bid = q.bid.priceMicros + shift;
    let ask = q.ask.priceMicros + shift;
    if (ask <= bid) ask = bid + 2n; // preserve the bid<ask invariant whatever the rounding
    return {
      ...q,
      bid: { ...q.bid, priceMicros: bid },
      ask: { ...q.ask, priceMicros: ask },
      reservationMicros: q.reservationMicros + shift,
    };
  }

  private deactivate(): void {
    if (this.wasActive) {
      this.wasActive = false;
      this.p.onChange?.({ active: false, ageMs: this.lastAge, shiftBps: 0 });
    }
  }
}
