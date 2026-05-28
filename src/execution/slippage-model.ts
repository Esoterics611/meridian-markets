// Linear price-impact slippage model (Kyle-lambda-ish):
//   impactBps = lambdaBps * (orderNotional / adv)
// where adv is the venue's per-symbol average daily volume in USDC units.
// Lambda is fit from real fills later; for the demo it's a constant.
//
// The model is intentionally simple — production desks layer in:
//   - sqrt-impact for the resilient component
//   - separate temporary vs permanent impact
//   - regime-dependent lambdas (vol-of-vol scaling)
// Session 13 lite ships the linear baseline only.

export interface SlippageInputs {
  /** Order notional in USDC units. */
  notionalUnits: bigint;
  /** Symbol's average daily volume in USDC units (venue-side). */
  advUnits: bigint;
  /** Lambda in basis points per (notional/ADV). 100 = 1 bp per 1% of ADV. */
  lambdaBps?: number;
  /** Side of the parent order; impact is signed when the caller wants directional cost. */
  side?: 'BUY' | 'SELL';
}

export interface SlippageEstimate {
  /** Magnitude of price impact in basis points. */
  impactBps: number;
  /** Signed impact: BUYs push price up (positive), SELLs push it down (negative). */
  signedImpactBps: number;
  /** USDC slippage cost = notional * impactBps / 10_000. */
  costUnits: bigint;
}

const DEFAULT_LAMBDA_BPS = 100; // 1 bp per 1% of ADV

export function estimateSlippage(i: SlippageInputs): SlippageEstimate {
  if (i.notionalUnits <= 0n) {
    return { impactBps: 0, signedImpactBps: 0, costUnits: 0n };
  }
  if (i.advUnits <= 0n) {
    // No ADV info → treat as worst-case: cap at 5% (500bps) so we don't NaN downstream.
    return { impactBps: 500, signedImpactBps: i.side === 'SELL' ? -500 : 500, costUnits: (i.notionalUnits * 500n) / 10_000n };
  }
  const lambda = i.lambdaBps ?? DEFAULT_LAMBDA_BPS;
  // Floating-point ratio is safe here — notional and adv are bounded by realistic balance sizes.
  const ratio = Number(i.notionalUnits) / Number(i.advUnits);
  const impactBps = Math.min(1000, lambda * ratio); // hard cap at 10% to keep estimates bounded
  const signedImpactBps = i.side === 'SELL' ? -impactBps : impactBps;
  // Bigint cost: notional * impactBps / 10_000, with a floor at 0.
  const costUnits = (i.notionalUnits * BigInt(Math.round(impactBps))) / 10_000n;
  return { impactBps, signedImpactBps, costUnits };
}
