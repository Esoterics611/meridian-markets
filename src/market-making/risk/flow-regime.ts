// FlowRegimeMachine — F4 Stage A: the flow-reactive risk THROTTLE (κ = 0 everywhere).
// docs/FLOW_REACTIVE_QUOTING.md §1 (FlowState) + §2.2–§2.4 (throttle responses) + §3
// (regime machine). SUPERSEDES the binary S4 SweepRegimeDetector (|flow|>0.65 × drift):
// run55 showed that gate wrong-shaped — kPEPE bled through 3 loss-stops with ZERO
// engagements while triggers fired marginally at 0.65–0.76. A binary pull at a high
// threshold protects nothing below the threshold and forfeits everything above it; this
// machine RAMPS a graduated defence in (widen, asymmetric widen, size cut) and reserves
// the quote-pull for the one shape that warrants it (sustained flow AGAINST inventory).
//
// THE TWO NON-NEGOTIABLE PRIORS (§0):
//   1. Flow is a risk throttle FIRST, directional alpha second. Stage A has NO
//      re-centering term — alpha = κ·f·g is Stage B, gated on the per-book
//      markout-on-flow regression over mm_fill_markout (F0 data, not yet in volume).
//   2. Toxicity ≠ |flow|. Toxicity = flow aligned AGAINST inventory. The machine is
//      driven by A = sign(q)·sign(f), not |f| alone.
//
// THE HARD INVARIANT (§3, asserted in the spec): FLATTEN-ONLY is reachable ONLY when
// A < 0 (flow pushing inventory further underwater). HARVEST (A > 0 — flow is taking
// our inventory off at prices that reduce us) NEVER flattens: flow with you is the
// exit, not the threat. The transition guard enforces this structurally.
//
// Pure + clock-free (caller passes nowMs) so it is unit-testable and replayable —
// the same discipline as SweepRegimeDetector. One instance per book (per-symbol flow
// memory). HALT (§3's bottom state: vol spike / stale feed) is NOT modelled here —
// the risk gate, loss-stop and feed watchdog already own those triggers.

export type FlowRegime = 'normal' | 'defensive' | 'harvest' | 'flatten-only';

export interface FlowRegimeConfig {
  /** Enter the defensive family when |f| exceeds this (hysteresis upper). Default 0.40. */
  thetaEnter?: number;
  /** Exit back to NORMAL only when |f| falls below this (hysteresis lower). Default 0.25. */
  thetaExit?: number;
  /** DEFENSIVE → FLATTEN-ONLY escalation: sustained |f| above this with A<0. Default 0.70. */
  thetaHigh?: number;
  /** EWMA smoothing per VOLUME tick (0..1, higher = faster). Default 0.05 (~20-tick memory). */
  ewmaAlpha?: number;
  /** Ramp start: g=0 until `persist` reaches this many volume ticks. Default 3. */
  persistMin?: number;
  /** Ramp full: g=1 at this many volume ticks (also the FLATTEN sustain gate). Default 10. */
  persistFull?: number;
  /** Minimum dwell per regime in ms — a transition is held back until the current regime
   *  has lived this long (kills chatter at the threshold). Default 3000. */
  dwellMs?: number;
  /** §2.2 symmetric toxicity widen gain λ: spreadScale = 1 + λ·T·g. Default 0.5. */
  lambda?: number;
  /** §2.3 extra widen on the TOXIC side (the side flow is hitting): ×(1 + wToxic·T·g). Default 1.0. */
  wToxic?: number;
  /** §2.3 widen on the safe side: ×(1 + wSafe·T·g). Default 0.25. */
  wSafe?: number;
  /** §2.4 size cut on the toxic side: ×clip(1 − sizeCut·T·g, sizeFloor, 1). Default 0.7. */
  sizeCut?: number;
  /** §2.4 floor for the toxic-side size scale (never below, except FLATTEN pulls it). Default 0.2. */
  sizeFloor?: number;
  /** §1/§6 toxicity blend: T = (1−b)·|f| + b·vpin. Default 0 (T = |f| until VPIN is
   *  validated to LEAD markout per book — Andersen–Bondarenko caution, §0). */
  vpinBlend?: number;
  /** In FLATTEN-ONLY, the reducing side's half-spread is tightened ×(1 − this·g) so the
   *  book sheds into the flow without crossing (κ=0 ⇒ no §4 taker decision yet). Default 0.5. */
  flattenTighten?: number;
  /** Change-driven observability (PART V, binding): fired on every regime TRANSITION with
   *  the full triggering FlowState. The module wires this to CONTROL ▸/BLOCKED ▸ log lines
   *  + tape events; replay/test instances may leave it unset. */
  onTransition?: (t: FlowTransition) => void;
}

/** The full FlowState + throttle responses for one tick (§1 signal layer + §2 control law). */
export interface FlowThrottle {
  regime: FlowRegime;
  /** EWMA'd signed aggressor-flow imbalance ∈ [−1,1]. */
  f: number;
  /** Consecutive volume ticks with |f| > θ_enter and stable sign. */
  persist: number;
  /** sign(f) flipped this tick (the front of the move reversing — itself information). */
  flip: boolean;
  /** Toxicity ∈ [0,1] = (1−b)·|f| + b·vpin. */
  T: number;
  /** Alignment = sign(q)·sign(f): −1 flow against inventory, +1 with it, 0 flat/quiet. */
  A: -1 | 0 | 1;
  /** Defence ramp ∈ [0,1] from persist (decays smoothly on flip rather than snapping). */
  g: number;
  /** §2.2: symmetric half-spread multiplier (≥ 1; 1 in NORMAL/HARVEST). */
  spreadScale: number;
  /** §2.3/§2.4 per-side responses (1 = untouched; size 0 = side pulled, FLATTEN-ONLY). */
  bidHalfScale: number;
  askHalfScale: number;
  bidSizeScale: number;
  askSizeScale: number;
}

/** A regime transition, with every number that triggered it (PART V observability). */
export interface FlowTransition {
  from: FlowRegime;
  to: FlowRegime;
  nowMs: number;
  f: number;
  persist: number;
  T: number;
  A: -1 | 0 | 1;
  g: number;
  /** Signed inventory units at the transition (the q in A = sign(q)·sign(f)). */
  inventoryUnits: bigint;
  /** The thresholds in force, so the log line is self-contained. */
  thetaEnter: number;
  thetaExit: number;
  thetaHigh: number;
}

/** Lifetime counters for the leak table / snapshot / sweep verdicts. */
export interface FlowRegimeStats {
  transitions: number;
  ticksNormal: number;
  ticksDefensive: number;
  ticksHarvest: number;
  ticksFlatten: number;
  /** FLATTEN-ONLY entries (each = the toxic side pulled until the regime exits). */
  flattenEntries: number;
  /** Entries into FLATTEN-ONLY observed with A ≥ 0 — MUST be 0 (the hard invariant). */
  flattenEntriesNotAligned: number;
  harvestEntries: number;
  flips: number;
}

function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function clip(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const NEUTRAL: Pick<FlowThrottle, 'spreadScale' | 'bidHalfScale' | 'askHalfScale' | 'bidSizeScale' | 'askSizeScale'> = {
  spreadScale: 1,
  bidHalfScale: 1,
  askHalfScale: 1,
  bidSizeScale: 1,
  askSizeScale: 1,
};

export class FlowRegimeMachine {
  private readonly thetaEnter: number;
  private readonly thetaExit: number;
  private readonly thetaHigh: number;
  private readonly alpha: number;
  private readonly persistMin: number;
  private readonly persistFull: number;
  private readonly dwellMs: number;
  private readonly lambda: number;
  private readonly wToxic: number;
  private readonly wSafe: number;
  private readonly sizeCut: number;
  private readonly sizeFloor: number;
  private readonly vpinBlend: number;
  private readonly flattenTighten: number;
  private readonly onTransition?: (t: FlowTransition) => void;

  private f = 0;
  private persist = 0;
  private g = 0;
  private regime: FlowRegime = 'normal';
  private regimeSinceMs = -Infinity;
  private readonly s: FlowRegimeStats = {
    transitions: 0,
    ticksNormal: 0,
    ticksDefensive: 0,
    ticksHarvest: 0,
    ticksFlatten: 0,
    flattenEntries: 0,
    flattenEntriesNotAligned: 0,
    harvestEntries: 0,
    flips: 0,
  };

  constructor(cfg: FlowRegimeConfig = {}) {
    this.thetaEnter = cfg.thetaEnter ?? 0.4;
    this.thetaExit = cfg.thetaExit ?? 0.25;
    this.thetaHigh = cfg.thetaHigh ?? 0.7;
    this.alpha = cfg.ewmaAlpha ?? 0.05;
    this.persistMin = cfg.persistMin ?? 3;
    this.persistFull = Math.max(cfg.persistFull ?? 10, (cfg.persistMin ?? 3) + 1);
    this.dwellMs = cfg.dwellMs ?? 3000;
    this.lambda = cfg.lambda ?? 0.5;
    this.wToxic = cfg.wToxic ?? 1.0;
    this.wSafe = cfg.wSafe ?? 0.25;
    this.sizeCut = cfg.sizeCut ?? 0.7;
    this.sizeFloor = cfg.sizeFloor ?? 0.2;
    this.vpinBlend = clip(cfg.vpinBlend ?? 0, 0, 1);
    this.flattenTighten = clip(cfg.flattenTighten ?? 0.5, 0, 0.9);
    this.onTransition = cfg.onTransition;
  }

  /**
   * Feed one tick (this interval's aggressor volumes + current signed inventory) and read
   * the throttle. A quiet tick (no volume) carries no new flow information: f and persist
   * hold, but regime/dwell still evaluate (inventory or time may have changed the picture).
   */
  update(nowMs: number, aggressiveBuyUnits: bigint, aggressiveSellUnits: bigint, inventoryUnits: bigint, vpin?: number): FlowThrottle {
    // §1 signal layer — EWMA on volume ticks only (quiet tick = no information, like S4).
    const buy = Number(aggressiveBuyUnits);
    const sell = Number(aggressiveSellUnits);
    let flip = false;
    if (buy + sell > 0) {
      const prevSign = sign(this.f);
      const imb = (buy - sell) / (buy + sell);
      this.f = this.f * (1 - this.alpha) + imb * this.alpha;
      const newSign = sign(this.f);
      // flip = the EWMA'd front of the move reversing through zero while the defence was
      // engaged — reset persist, decay g below (don't whipsaw a defensive book on it).
      flip = prevSign !== 0 && newSign !== 0 && newSign !== prevSign;
      if (flip) {
        this.s.flips += 1;
        this.persist = 0;
      } else if (Math.abs(this.f) > this.thetaEnter) {
        this.persist += 1;
      } else if (Math.abs(this.f) < this.thetaExit) {
        this.persist = 0;
      }
      // between θ_exit and θ_enter: hysteresis band — persist holds where it is.
    }
    const T = clip((1 - this.vpinBlend) * Math.abs(this.f) + this.vpinBlend * clip(vpin ?? 0, 0, 1), 0, 1);
    const A = (sign(this.f) === 0 || inventoryUnits === 0n ? 0 : sign(this.f) * (inventoryUnits > 0n ? 1 : -1)) as -1 | 0 | 1;
    // Ramp g from persist; on flip/decay, g eases out (×0.7/tick) instead of snapping —
    // the front reversing is information, not an all-clear (§1 gating rules).
    const gTarget = clip((this.persist - this.persistMin) / (this.persistFull - this.persistMin), 0, 1);
    this.g = gTarget >= this.g ? gTarget : Math.max(gTarget, this.g * 0.7);

    this.step(nowMs, A, inventoryUnits, T);
    this.countTick();
    return { regime: this.regime, f: this.f, persist: this.persist, flip, T, A, g: this.g, ...this.responses(T, A) };
  }

  /** §3 transition logic, hysteresis + dwell gated. */
  private step(nowMs: number, A: -1 | 0 | 1, inventoryUnits: bigint, T: number): void {
    const absF = Math.abs(this.f);
    const engaged = absF > this.thetaEnter && this.persist >= this.persistMin;
    const calm = absF < this.thetaExit;
    const dwelled = nowMs - this.regimeSinceMs >= this.dwellMs;

    let next: FlowRegime = this.regime;
    switch (this.regime) {
      case 'normal':
        // A>0 ⇒ HARVEST; A<0 OR flat inventory (A=0 — informed flow can still pick the
        // side it's hitting) ⇒ DEFENSIVE. No dwell on the way IN: defence must not lag.
        if (engaged) next = A > 0 ? 'harvest' : 'defensive';
        break;
      case 'defensive':
        if (calm && dwelled) next = 'normal';
        else if (A > 0 && dwelled) next = 'harvest'; // inventory flipped under us — flow now reduces
        else if (A < 0 && absF > this.thetaHigh && this.persist >= this.persistFull && dwelled) next = 'flatten-only';
        break;
      case 'harvest':
        // HARD INVARIANT: harvest NEVER escalates to flatten — flow with you is the exit.
        if ((calm || inventoryUnits === 0n) && dwelled) next = 'normal'; // flattened by flow or flow died
        else if (A < 0 && dwelled) next = 'defensive'; // inventory/flow re-aligned against us
        break;
      case 'flatten-only':
        // Exit when flow cools below θ_high, the position is flat (nothing left to shed),
        // or alignment turned (A ≥ 0 — flow no longer pushing us underwater).
        if (dwelled && (absF < this.thetaHigh || inventoryUnits === 0n || A >= 0)) next = calm ? 'normal' : 'defensive';
        break;
    }
    if (next === this.regime) return;
    // Belt-and-braces on the invariant: a flatten entry is only legal from DEFENSIVE with
    // A<0 (the switch above already guarantees it; the counter makes it assertable).
    if (next === 'flatten-only') {
      if (A >= 0) {
        this.s.flattenEntriesNotAligned += 1; // must stay 0 — tested + asserted in the sweep
        return; // refuse the illegal transition outright
      }
      this.s.flattenEntries += 1;
    }
    if (next === 'harvest') this.s.harvestEntries += 1;
    const from = this.regime;
    this.regime = next;
    this.regimeSinceMs = nowMs;
    this.s.transitions += 1;
    if (this.onTransition) {
      try {
        this.onTransition({
          from,
          to: next,
          nowMs,
          f: this.f,
          persist: this.persist,
          T,
          A,
          g: this.g,
          inventoryUnits,
          thetaEnter: this.thetaEnter,
          thetaExit: this.thetaExit,
          thetaHigh: this.thetaHigh,
        });
      } catch {
        /* observability must never break the quote path */
      }
    }
  }

  /** §2.2–§2.4 throttle responses for the current regime. κ = 0: no re-centering anywhere. */
  private responses(T: number, A: -1 | 0 | 1): Omit<FlowThrottle, 'regime' | 'f' | 'persist' | 'flip' | 'T' | 'A' | 'g'> {
    const g = this.g;
    // The toxic side = the side flow is HITTING: buy flow (f>0) lifts our ask, sell flow
    // (f<0) hits our bid. With f≈0 there is no toxic side (NORMAL responses are 1 anyway).
    const toxicAsk = this.f > 0;
    switch (this.regime) {
      case 'normal':
        return { ...NEUTRAL };
      case 'harvest': {
        // §2.3 HARVEST override: the toxic side here is the REDUCING side (A>0 — flow takes
        // inventory off). Do NOT widen it; leave it at base so flow flattens us. No size cut
        // (we WANT those fills); the adding side gets the mild safe-widen so we don't reload
        // into a move. No symmetric widen.
        const safeWiden = 1 + this.wSafe * T * g;
        return {
          spreadScale: 1,
          bidHalfScale: toxicAsk ? safeWiden : 1,
          askHalfScale: toxicAsk ? 1 : safeWiden,
          bidSizeScale: 1,
          askSizeScale: 1,
        };
      }
      case 'defensive': {
        const toxicWiden = 1 + this.wToxic * T * g;
        const safeWiden = 1 + this.wSafe * T * g;
        const toxicSize = clip(1 - this.sizeCut * T * g, this.sizeFloor, 1);
        return {
          spreadScale: 1 + this.lambda * T * g,
          bidHalfScale: toxicAsk ? safeWiden : toxicWiden,
          askHalfScale: toxicAsk ? toxicWiden : safeWiden,
          bidSizeScale: toxicAsk ? 1 : toxicSize,
          askSizeScale: toxicAsk ? toxicSize : 1,
        };
      }
      case 'flatten-only': {
        // Pull the toxic side entirely (it is the ADDING side when A<0); TIGHTEN the
        // reducing side so the book sheds passively into the flow. κ=0 ⇒ no §4 taker
        // cross here — the loss-stop remains the hard backstop.
        const tighten = 1 - this.flattenTighten * g;
        return {
          spreadScale: 1,
          bidHalfScale: toxicAsk ? tighten : 1, // unused side is pulled via size 0 anyway
          askHalfScale: toxicAsk ? 1 : tighten,
          bidSizeScale: toxicAsk ? 1 : 0,
          askSizeScale: toxicAsk ? 0 : 1,
        };
      }
    }
  }

  private countTick(): void {
    if (this.regime === 'normal') this.s.ticksNormal += 1;
    else if (this.regime === 'defensive') this.s.ticksDefensive += 1;
    else if (this.regime === 'harvest') this.s.ticksHarvest += 1;
    else this.s.ticksFlatten += 1;
  }

  /** Signed flow EWMA ∈ [−1,1] (UI/diagnostics — same read SweepRegimeDetector exposed). */
  flow(): number {
    return this.f;
  }

  current(): FlowRegime {
    return this.regime;
  }

  stats(): FlowRegimeStats {
    return { ...this.s };
  }
}
