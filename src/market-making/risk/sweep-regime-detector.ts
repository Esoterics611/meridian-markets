// SweepRegimeDetector (S4, Journal #56) — the trend/sweep regime gate.
//
// THE PROBLEM IT SOLVES (run53 / time-stop sweep #53): the desk's recurring loss shape is a
// one-sided SWEEP — informed flow hits one side repeatedly while the price runs, the maker
// accumulates inventory AGAINST the move, and the warehouse marks down in one window. The
// loss-stop fires AFTER the damage; this gate pulls quotes BEFORE inventory builds: "the stop
// must know the regime before it earns the right to quote" (#53 verdict, now operational).
//
// THE SIGNAL (deliberately simple + per-tick cheap — both legs must agree):
//   1. FLOW   — EWMA of the signed aggressor-flow imbalance ((buy−sell)/(buy+sell) per tick,
//               volume ticks only). |ewma| > flowThreshold ⇒ the tape is one-sided.
//   2. PRICE  — drift over the trailing windowMs, SAME SIGN as the flow and |drift| ≥
//               minDriftBps ⇒ the price is actually following (one-sided flow into a wall of
//               liquidity is absorption, not a sweep — we keep quoting that).
// Both true ⇒ SWEEP: the caller pulls quotes. After the last sweep tick, quoting stays paused
// for cooldownMs (re-engage only once the tape has been two-sided for a while — the re-entry
// discipline Ronnie asked for: get out, THEN re-enter).
//
// HONESTY: thresholds are PRIORS (flow 0.65 / drift 5bps / 30s window / 90s cooldown), not
// fitted values — run54+ measures what the gate actually saved (blockedQuotes + the leak
// table's warehouse column) and the replay harness can sweep them offline. The detector is
// pure and clock-free (caller passes nowMs) so it is unit-testable and replayable.

export interface SweepRegimeConfig {
  /** |flow EWMA| above this = one-sided tape. Default 0.65. */
  flowThreshold?: number;
  /** EWMA smoothing per VOLUME tick (0..1, higher = faster). Default 0.05 (~20-tick memory). */
  flowEwmaAlpha?: number;
  /** Price-drift lookback. Default 30_000. */
  windowMs?: number;
  /** Min |drift| over the window (bps of mid) for the price leg to confirm. Default 5. */
  minDriftBps?: number;
  /** Quotes stay pulled this long after the last sweep tick. Default 90_000. */
  cooldownMs?: number;
}

export type RegimeState = 'calm' | 'sweep' | 'cooldown';

export class SweepRegimeDetector {
  private readonly flowThreshold: number;
  private readonly alpha: number;
  private readonly windowMs: number;
  private readonly minDriftBps: number;
  private readonly cooldownMs: number;

  private flowEwma = 0;
  private mids: Array<{ ts: number; mid: number }> = [];
  private sweepUntilMs = 0;
  private _sweepTicks = 0;
  private _engagements = 0;

  constructor(cfg: SweepRegimeConfig = {}) {
    this.flowThreshold = cfg.flowThreshold ?? 0.65;
    this.alpha = cfg.flowEwmaAlpha ?? 0.05;
    this.windowMs = cfg.windowMs ?? 30_000;
    this.minDriftBps = cfg.minDriftBps ?? 5;
    this.cooldownMs = cfg.cooldownMs ?? 90_000;
  }

  /**
   * Feed one tick (mid + the interval's aggressor volumes) and read the regime.
   * 'sweep'/'cooldown' ⇒ the caller must pull quotes this tick.
   */
  update(nowMs: number, midMicros: bigint, aggressiveBuyUnits: bigint, aggressiveSellUnits: bigint): RegimeState {
    // flow leg — update only on ticks that traded (a quiet tick is "no new information")
    const buy = Number(aggressiveBuyUnits);
    const sell = Number(aggressiveSellUnits);
    if (buy + sell > 0) {
      const imb = (buy - sell) / (buy + sell);
      this.flowEwma = this.flowEwma * (1 - this.alpha) + imb * this.alpha;
    }
    // price leg — trailing drift over windowMs
    const mid = Number(midMicros);
    if (mid > 0) {
      this.mids.push({ ts: nowMs, mid });
      const cutoff = nowMs - this.windowMs;
      while (this.mids.length > 1 && this.mids[0].ts < cutoff) this.mids.shift();
    }
    const oldest = this.mids[0];
    const driftBps = oldest && oldest.mid > 0 && mid > 0 ? ((mid - oldest.mid) / oldest.mid) * 10_000 : 0;

    const oneSided = Math.abs(this.flowEwma) > this.flowThreshold;
    const confirmed = Math.abs(driftBps) >= this.minDriftBps && Math.sign(driftBps) === Math.sign(this.flowEwma);
    if (oneSided && confirmed) {
      if (nowMs >= this.sweepUntilMs) this._engagements += 1; // a NEW engagement (was calm)
      this._sweepTicks += 1;
      this.sweepUntilMs = nowMs + this.cooldownMs;
      return 'sweep';
    }
    return nowMs < this.sweepUntilMs ? 'cooldown' : 'calm';
  }

  /** Signed flow EWMA ∈ [−1,1] — the smoothed "front of the move" (UI/diagnostics). */
  flow(): number {
    return this.flowEwma;
  }

  /** Diagnostics for the snapshot/leak table: how often the gate engaged + held. */
  stats(): { engagements: number; sweepTicks: number } {
    return { engagements: this._engagements, sweepTicks: this._sweepTicks };
  }
}
