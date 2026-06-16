// RegimeMonitor — P3 of the standalone "take sides" book (REGIME_DIRECTIONAL_BOOK.md).
// The per-symbol "WEATHER": it reads funding / basis / vol each tick, classifies the
// market into a tradeability state, and FIRES one event when the weather flips. It is
// the book's stand-aside source ("don't take a side into a basis blowout / vol spike")
// AND the "monitor regime changes" deliverable the trader watches on the Activity feed.
//
// Same discipline as FlowRegimeMachine (risk/flow-regime.ts): PURE + clock-free (the
// caller passes nowMs + the reads), one instance per symbol, hysteresis + dwell so it
// does NOT chatter at a threshold, and an onRegimeChange callback fired exactly once per
// real transition (wrapped in try/catch — observability must never break the loop). It
// only READS and EMITS; it never trades.
//
// THREE sub-regimes, each on the shared FAVORABLE / NEUTRAL / ADVERSE ladder (the color
// law below — defined ONCE so the S4 UI chips mean exactly what the engine does):
//   • funding — sign + magnitude of trailing funding. A TAILWIND read, not a hazard:
//     a clear, persistent one-sided regime is FAVORABLE (there is a carry side to lean),
//     flat funding is NEUTRAL. It never forces stand-aside on its own; the alert fires on
//     a SIDE flip (paid-short ⇄ paid-long), the thing a trader actually reacts to.
//   • basis — |cross-venue basis|. Calm + small ⇒ FAVORABLE; widening ⇒ NEUTRAL; a
//     BLOWOUT past the fee+margin threshold (≈19bp, the CrossVenueBasisArbDetector idea)
//     ⇒ ADVERSE (a dislocation — stand aside).
//   • vol — a relative realised-vol SPIKE detector (short vs slow EWMA of squared returns,
//     price-scale-invariant). Quiet ⇒ FAVORABLE; rising ⇒ NEUTRAL; SPIKE ⇒ ADVERSE.
//
// overall = STAND_ASIDE if ANY HAZARD dim (basis/vol) is ADVERSE or the feed is stale;
// else HOLD_ONLY if any hazard dim is NEUTRAL (hold, no new entry); else TRADEABLE. So
// STAND_ASIDE is reachable ONLY from a real adverse read — the honesty invariant (asserted
// in the spec). Funding is deliberately excluded from the hazard ladder.

import { computeThreshold } from '../../market-data/cross-venue/cross-venue-basis-arb';
import { DeskEventInput, regimeEvent } from '../events/desk-event';

// ── The color law (ONE place — S4 maps these semantic colors to hex) ──────────
export type RegimeLevel = 'FAVORABLE' | 'NEUTRAL' | 'ADVERSE';
export type RegimeOverall = 'TRADEABLE' | 'HOLD_ONLY' | 'STAND_ASIDE';
export type RegimeColor = 'green' | 'amber' | 'red';
export type FundingSide = 'paid-short' | 'flat' | 'paid-long';
export type RegimeDimension = 'funding' | 'basis' | 'vol';

export const REGIME_LEVEL_COLOR: Readonly<Record<RegimeLevel, RegimeColor>> = {
  FAVORABLE: 'green',
  NEUTRAL: 'amber',
  ADVERSE: 'red',
};
export const REGIME_OVERALL_COLOR: Readonly<Record<RegimeOverall, RegimeColor>> = {
  TRADEABLE: 'green', // the book may take/hold a position
  HOLD_ONLY: 'amber', // hold only — no new entry
  STAND_ASIDE: 'red', // stand aside / flatten
};

const HAZARD_ORDINAL: Readonly<Record<RegimeLevel, number>> = { FAVORABLE: 0, NEUTRAL: 1, ADVERSE: 2 };

// ── Tick + state shapes ───────────────────────────────────────────────────────
export interface RegimeTick {
  /** Current time (ms). */
  readonly nowMs: number;
  /** Trailing-mean perp funding rate per HOUR (+ ⇒ longs pay ⇒ shorts are paid). Omit ⇒ hold. */
  readonly fundingRatePerHour?: number;
  /** Signed cross-venue basis in BPS. Omit ⇒ hold the basis read. */
  readonly basisBps?: number;
  /** The latest per-bar log return, feeding the vol EWMA. Omit ⇒ no vol update this tick. */
  readonly ret?: number;
  /** Caller-detected stale/broken feed ⇒ force STAND_ASIDE (the feed watchdog owns the trigger). */
  readonly feedStale?: boolean;
}

export interface FundingState {
  readonly level: RegimeLevel; // FAVORABLE (clear carry) | NEUTRAL (flat) — never ADVERSE
  readonly side: FundingSide;
  readonly ratePerHour: number;
}
export interface BasisState {
  readonly level: RegimeLevel;
  readonly basisBps: number;
}
export interface VolState {
  readonly level: RegimeLevel;
  /** short/slow realised-vol ratio (1 ≈ normal; >1 = rising/spiking). 1 until warm. */
  readonly ratio: number;
}

export interface RegimeState {
  readonly symbol: string;
  readonly funding: FundingState;
  readonly basis: BasisState;
  readonly vol: VolState;
  readonly overall: RegimeOverall;
  /** Convenience for the book's tick.standAside (true ⇔ overall === STAND_ASIDE). */
  readonly standAside: boolean;
}

export interface RegimeTransition {
  readonly symbol: string;
  readonly dimension: RegimeDimension;
  readonly from: string; // RegimeLevel for basis/vol, FundingSide for funding
  readonly to: string;
  readonly nowMs: number;
  /** Plain-English sentence a non-quant reads (e.g. "funding flipped paid-short → paid-long"). */
  readonly detail: string;
  /** The full state at the transition (for the UI / tape). */
  readonly state: RegimeState;
}

export interface RegimeMonitorConfig {
  // funding (per-hour rate magnitudes; annualised ≈ rate × 8760)
  /** |funding/hr| below this ⇒ "flat" side + NEUTRAL. Default 4e-6 (≈ ±3.5%/yr). */
  fundingFlatEps?: number;
  /** |funding/hr| at/above this ⇒ FAVORABLE (a clear carry regime). Default 1.2e-5 (≈ ±10.5%/yr). */
  fundingFavorableMag?: number;
  // basis (bps)
  /** |basis| at/above this ⇒ NEUTRAL (widening / watch). Default 10bp. */
  basisNeutralBps?: number;
  /** |basis| at/above this ⇒ ADVERSE (BLOWOUT). Default computeThreshold(14,5) = 19bp. */
  basisAdverseBps?: number;
  // vol (relative short/slow realised-vol ratio)
  /** ratio at/above this ⇒ NEUTRAL (rising). Default 1.4. */
  volRisingRatio?: number;
  /** ratio at/above this ⇒ ADVERSE (SPIKE). Default 2.2. */
  volSpikeRatio?: number;
  /** EWMA weight for the FAST vol estimate. Default 0.30. */
  volShortAlpha?: number;
  /** EWMA weight for the SLOW baseline. Default 0.03. */
  volSlowAlpha?: number;
  /** Vol updates before a SPIKE may be declared (cold-start guard). Default 8. */
  volWarmupTicks?: number;
  // shared
  /** Fraction of a threshold a value must fall BACK through to step a level down (hysteresis). Default 0.75. */
  exitFrac?: number;
  /** Minimum ms in a level/side before a DE-escalation may commit (escalation to a worse
   *  hazard is immediate — protection must not lag). Default 60000 (1 min). */
  dwellMs?: number;
  /** Fired exactly once per real sub-regime transition. The caller wires it to the tape. */
  onRegimeChange?: (t: RegimeTransition) => void;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Map a non-negative value to FAVORABLE/NEUTRAL/ADVERSE with current-level hysteresis. */
function hazardLevel(v: number, cur: RegimeLevel, neutral: number, adverse: number, exitFrac: number): RegimeLevel {
  const advExit = adverse * exitFrac;
  const neuExit = neutral * exitFrac;
  if (cur === 'ADVERSE') return v >= advExit ? 'ADVERSE' : v >= neuExit ? 'NEUTRAL' : 'FAVORABLE';
  if (cur === 'NEUTRAL') return v >= adverse ? 'ADVERSE' : v >= neuExit ? 'NEUTRAL' : 'FAVORABLE';
  return v >= adverse ? 'ADVERSE' : v >= neutral ? 'NEUTRAL' : 'FAVORABLE'; // from FAVORABLE
}

export class RegimeMonitor {
  private readonly cfg: Required<Omit<RegimeMonitorConfig, 'onRegimeChange'>>;
  private readonly onRegimeChange?: (t: RegimeTransition) => void;

  // funding state
  private fundingInit = false;
  private fundingLevel: RegimeLevel = 'NEUTRAL';
  private fundingSide: FundingSide = 'flat';
  private fundingSideSinceMs = 0;
  private fundingRate = 0;
  // basis state
  private basisInit = false;
  private basisLevel: RegimeLevel = 'FAVORABLE';
  private basisSinceMs = 0;
  private basisBps = 0;
  // vol state
  private volInit = false;
  private volLevel: RegimeLevel = 'NEUTRAL'; // NEUTRAL until warm (never spurious-spike on cold start)
  private volSinceMs = 0;
  private shortVar = 0;
  private slowVar = 0;
  private volTicks = 0;
  private volRatio = 1;
  // feed
  private feedStale = false;

  constructor(
    public readonly symbol: string,
    cfg: RegimeMonitorConfig = {},
  ) {
    this.cfg = {
      fundingFlatEps: cfg.fundingFlatEps ?? 4e-6,
      fundingFavorableMag: cfg.fundingFavorableMag ?? 1.2e-5,
      basisNeutralBps: cfg.basisNeutralBps ?? 10,
      basisAdverseBps: cfg.basisAdverseBps ?? computeThreshold(14, 5), // 19bp
      volRisingRatio: cfg.volRisingRatio ?? 1.4,
      volSpikeRatio: cfg.volSpikeRatio ?? 2.2,
      volShortAlpha: clamp(cfg.volShortAlpha ?? 0.3, 0.01, 1),
      volSlowAlpha: clamp(cfg.volSlowAlpha ?? 0.03, 0.001, 1),
      volWarmupTicks: cfg.volWarmupTicks ?? 8,
      exitFrac: clamp(cfg.exitFrac ?? 0.75, 0.1, 0.99),
      dwellMs: cfg.dwellMs ?? 60_000,
    };
    this.onRegimeChange = cfg.onRegimeChange;
  }

  /** Feed one tick; reclassify each present dimension; fire transitions; return the state. */
  update(tick: RegimeTick): RegimeState {
    this.feedStale = !!tick.feedStale;
    if (tick.fundingRatePerHour !== undefined && Number.isFinite(tick.fundingRatePerHour)) {
      this.updateFunding(tick.nowMs, tick.fundingRatePerHour);
    }
    if (tick.basisBps !== undefined && Number.isFinite(tick.basisBps)) {
      this.updateBasis(tick.nowMs, tick.basisBps);
    }
    if (tick.ret !== undefined && Number.isFinite(tick.ret)) {
      this.updateVol(tick.nowMs, tick.ret);
    }
    return this.state();
  }

  private updateFunding(nowMs: number, ratePerHour: number): void {
    this.fundingRate = ratePerHour;
    const mag = Math.abs(ratePerHour);
    // Level is a tailwind read (FAVORABLE/NEUTRAL), with hysteresis on the favorable band.
    const favEnter = this.cfg.fundingFavorableMag;
    const favExit = favEnter * this.cfg.exitFrac;
    this.fundingLevel = this.fundingLevel === 'FAVORABLE'
      ? (mag >= favExit ? 'FAVORABLE' : 'NEUTRAL')
      : (mag >= favEnter ? 'FAVORABLE' : 'NEUTRAL');
    // Side (the alert axis): paid-short when longs pay (funding>0), paid-long when funding<0.
    const eps = this.cfg.fundingFlatEps;
    const side: FundingSide = ratePerHour > eps ? 'paid-short' : ratePerHour < -eps ? 'paid-long' : 'flat';
    if (!this.fundingInit) {
      // First observation establishes the baseline silently — an alert announces a CHANGE.
      this.fundingInit = true;
      this.fundingSide = side;
      this.fundingSideSinceMs = nowMs;
      return;
    }
    if (side !== this.fundingSide && nowMs - this.fundingSideSinceMs >= this.cfg.dwellMs) {
      const from = this.fundingSide;
      this.fundingSide = side;
      this.fundingSideSinceMs = nowMs;
      this.fire(nowMs, 'funding', from, side, `funding flipped ${from} → ${side}`);
    }
  }

  private updateBasis(nowMs: number, basisBps: number): void {
    this.basisBps = basisBps;
    const next = hazardLevel(Math.abs(basisBps), this.basisLevel, this.cfg.basisNeutralBps, this.cfg.basisAdverseBps, this.cfg.exitFrac);
    if (!this.basisInit) {
      this.basisInit = true;
      this.basisLevel = next;
      this.basisSinceMs = nowMs;
      return;
    }
    this.commitHazard('basis', next, nowMs, () => this.basisLevel, (l) => (this.basisLevel = l), () => this.basisSinceMs, (t) => (this.basisSinceMs = t), (from, to) => this.basisDetail(from, to));
  }

  private updateVol(nowMs: number, ret: number): void {
    const sq = ret * ret;
    this.shortVar = this.volTicks === 0 ? sq : this.shortVar * (1 - this.cfg.volShortAlpha) + sq * this.cfg.volShortAlpha;
    this.slowVar = this.volTicks === 0 ? sq : this.slowVar * (1 - this.cfg.volSlowAlpha) + sq * this.cfg.volSlowAlpha;
    this.volTicks += 1;
    this.volRatio = this.slowVar > 0 ? Math.sqrt(this.shortVar / this.slowVar) : 1;
    let next = hazardLevel(this.volRatio, this.volLevel, this.cfg.volRisingRatio, this.cfg.volSpikeRatio, this.cfg.exitFrac);
    if (this.volTicks < this.cfg.volWarmupTicks && next === 'ADVERSE') next = 'NEUTRAL'; // cold-start guard
    if (!this.volInit) {
      this.volInit = true;
      this.volLevel = next;
      this.volSinceMs = nowMs;
      return;
    }
    this.commitHazard('vol', next, nowMs, () => this.volLevel, (l) => (this.volLevel = l), () => this.volSinceMs, (t) => (this.volSinceMs = t), (from, to) => this.volDetail(from, to));
  }

  /** Commit a hazard-dim level with the escalate-now / de-escalate-on-dwell rule + fire. */
  private commitHazard(
    dim: RegimeDimension,
    next: RegimeLevel,
    nowMs: number,
    getLevel: () => RegimeLevel,
    setLevel: (l: RegimeLevel) => void,
    getSince: () => number,
    setSince: (t: number) => void,
    detail: (from: RegimeLevel, to: RegimeLevel) => string,
  ): void {
    const cur = getLevel();
    if (next === cur) return;
    const escalating = HAZARD_ORDINAL[next] > HAZARD_ORDINAL[cur];
    if (!escalating && nowMs - getSince() < this.cfg.dwellMs) return; // de-escalation waits out the dwell
    setLevel(next);
    setSince(nowMs);
    this.fire(nowMs, dim, cur, next, detail(cur, next));
  }

  private basisDetail(from: RegimeLevel, to: RegimeLevel): string {
    const bp = `${this.basisBps >= 0 ? '+' : ''}${this.basisBps.toFixed(1)}bp`;
    if (to === 'ADVERSE') return `basis BLEW OUT to ${bp} — standing aside`;
    if (to === 'FAVORABLE') return `basis calmed to ${bp}`;
    return from === 'ADVERSE' ? `basis easing (${bp})` : `basis widening to ${bp}`;
  }

  private volDetail(_from: RegimeLevel, to: RegimeLevel): string {
    const x = `×${this.volRatio.toFixed(2)}`;
    if (to === 'ADVERSE') return `vol SPIKE (${x} normal) — standing aside`;
    if (to === 'FAVORABLE') return `vol quiet again (${x})`;
    return `vol rising (${x})`;
  }

  private fire(nowMs: number, dimension: RegimeDimension, from: string, to: string, detail: string): void {
    if (!this.onRegimeChange) return;
    try {
      this.onRegimeChange({ symbol: this.symbol, dimension, from, to, nowMs, detail, state: this.state() });
    } catch {
      /* observability must never break the loop */
    }
  }

  /** The current weather (what the S4 Weather strip renders + the book's stand-aside source). */
  state(): RegimeState {
    const hazards: RegimeLevel[] = [this.basisLevel, this.volLevel];
    const overall: RegimeOverall =
      this.feedStale || hazards.includes('ADVERSE')
        ? 'STAND_ASIDE'
        : hazards.includes('NEUTRAL')
          ? 'HOLD_ONLY'
          : 'TRADEABLE';
    return {
      symbol: this.symbol,
      funding: { level: this.fundingLevel, side: this.fundingSide, ratePerHour: this.fundingRate },
      basis: { level: this.basisLevel, basisBps: this.basisBps },
      vol: { level: this.volLevel, ratio: this.volRatio },
      overall,
      standAside: overall === 'STAND_ASIDE',
    };
  }
}

/** Map a fired transition to a desk-event-tape input (the REGIME ▸ line on the Activity feed). */
export function regimeChangeEvent(t: RegimeTransition): DeskEventInput {
  return regimeEvent({ ts: t.nowMs, symbol: t.symbol, detail: t.detail });
}
