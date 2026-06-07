// FlowToxicityScaler — the F3 "confidence-scaled spread" driver, shared by the offline
// LOB replay (backtest/lob-replay.ts) and the LIVE fast engine so the two never diverge.
//
// Avoiding INFORMED orders (adverse selection) is the core market-making problem: an
// informed trader hits your quote precisely when it's about to be wrong, so you fill
// right before the price runs away from you. Informed flow shows up as ONE-SIDED
// aggressor flow. We measure that directly —
//
//     τ = |aggressiveBuy − aggressiveSell| / (aggressiveBuy + aggressiveSell)  ∈ [0,1]
//
// τ→0 is balanced, two-sided, benign flow (noise traders both ways — the regime you WANT
// to quote tight into and farm the rebate). τ→1 is a one-sided sweep (informed / toxic —
// where you get picked off). We scale the half-spread by τ RELATIVE to its own rolling
// average, so the book TIGHTENS into calm flow and WIDENS into a sweep. Using the rolling
// ratio (not τ itself) makes it self-normalising per coin/regime — no fixed gain to tune.
// Clamped to [minScale, maxScale]. This is the validated #27–#32 fair-value/cadence work's
// width knob; the micro-price (l2-microprice) is its companion CENTER knob.

export interface FlowToxicityScalerConfig {
  /** Rolling window (snapshots) for the toxicity average. */
  windowBars: number;
  /** Tightest scale, applied when current toxicity is below its average (calm). Default 0.5. */
  minScale: number;
  /** Widest scale, applied when current toxicity spikes above its average (toxic). Default 3.0. */
  maxScale: number;
}

export class FlowToxicityScaler {
  private readonly tox: number[] = [];
  private readonly minScale: number;
  private readonly maxScale: number;

  constructor(cfg: FlowToxicityScalerConfig) {
    this.windowBars = Math.max(1, Math.floor(cfg.windowBars));
    this.minScale = cfg.minScale;
    this.maxScale = cfg.maxScale;
  }
  private readonly windowBars: number;

  /**
   * Record this step's aggressor flow and return the clamped half-spread scale.
   * Returns 1 (neutral) until the window has seen any flow, so a warming book is unchanged.
   */
  scale(aggressiveBuyUnits: bigint, aggressiveSellUnits: bigint): number {
    const flow = Number(aggressiveBuyUnits + aggressiveSellUnits);
    const tau = flow > 0 ? Math.abs(Number(aggressiveBuyUnits - aggressiveSellUnits)) / flow : 0;
    this.tox.push(tau);
    if (this.tox.length > this.windowBars) this.tox.shift();
    const avg = this.tox.reduce((a, b) => a + b, 0) / this.tox.length;
    const raw = avg > 1e-9 ? tau / avg : 1;
    return Math.min(this.maxScale, Math.max(this.minScale, raw));
  }
}
