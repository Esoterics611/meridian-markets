// Flow-shadow recorder seam: the fast engine emits one FlowShadowObs per (throttled)
// snapshot for the SHADOW directional signal — measured + recorded but NEVER fed to a
// quote (zero P&L impact by construction; it's a separate field from the quoting bias).
// The offline gate (scripts/flow-bias-markout.ts) joins each obs to its forward return
// and scores the markout / forward-return IC; the signal earns `validated` only if it
// clears. A no-op sink is the default ⇒ the engine stays pure/testable unless wired.

export interface FlowShadowObs {
  readonly tsMs: number;
  readonly symbol: string;
  /** The raw (unvalidated) bias the flow source emitted, ∈ [−1,+1]. */
  readonly signal: number;
  /** Top-N L2 book imbalance ∈ [−1,+1] (the signal's input). */
  readonly bookImbalance: number;
  /** Trade-flow imbalance (aggressor buy−sell)/(buy+sell) this step; sparse sub-second. */
  readonly tradeFlowImbalance: number;
  /** True fair value (mid) at the obs, as a bigint-micros string — forward returns score against this. */
  readonly midMicros: string;
  /** Micro-price center (bigint-micros string) if computed — a second candidate to score offline. */
  readonly microMicros: string | null;
  /** Live VPIN ∈ [0,1] at the obs (WP2 — the toxicity-validation covariate); null pre-WP2 capture
   *  or when no estimator is wired. */
  readonly vpin?: number | null;
  /** The F3 spread scale applied this step (1 = neutral); null when F3 is off. Lets the offline
   *  gate check whether the defence reacted to the toxicity it should have (study §2.2e). */
  readonly f3Scale?: number | null;
}

export interface IFlowShadowRecorder {
  record(obs: FlowShadowObs): void;
}

/** Default sink: drops everything (keeps the engine pure unless a real recorder is wired). */
export class NoopFlowShadowRecorder implements IFlowShadowRecorder {
  record(_obs: FlowShadowObs): void {
    /* no-op */
  }
}
