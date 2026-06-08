// Gamma-overlay economics (HEDGING_MODEL.md §3).
//
// A market maker is structurally SHORT gamma — it bleeds ≈ ½·Γ·(ΔS)² on realised moves, and that
// bleed IS adverse selection. A long-gamma overlay (buy options) offsets it, earning the classic
// delta-hedged-option / variance result ½·Γ·S²·(σ_real² − σ_impl²)·T minus the option's cost. So
// the whole decision collapses to ONE comparison: REALISED vol vs IMPLIED vol. Implied ≥ realised
// on average (the volatility risk premium — sellers charge for it), so buying gamma is usually
// slightly −EV: insurance, not an engine. It only clears its premium in windows where the market
// realises MORE than options priced in — which is exactly an MM's worst (toxic, high-vol) windows.

/** Annualised realised volatility from a close series: σ = stdev(log returns)·√periodsPerYear. */
export function realizedVolAnnualized(closes: number[], periodsPerYear: number): number {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

export interface GammaOverlayInput {
  /** Annualised realised vol over the window (what the desk actually ate). */
  realizedVol: number;
  /** Annualised implied vol the overlay would pay for (Deribit ATM markIv). */
  impliedVol: number;
  /** The desk's short-gamma bleed over the window, USD (≈ the adverse-selection loss). */
  bleedUsd: number;
  /** Option transaction cost (premium spread + fees) to put the overlay on, USD. */
  costUsd?: number;
}

export interface GammaOverlayResult {
  /** 1 − σ_impl²/σ_real² — the share of the bleed a full long-gamma offset recovers (can be < 0). */
  recoverFraction: number;
  /** bleedUsd · recoverFraction — gross USD the overlay recovers (negative when iv > rv). */
  recoveredUsd: number;
  /** recoveredUsd − costUsd — the overlay's net. */
  netUsd: number;
  /** Does long gamma clear its premium here? (realised vol must beat implied + cost.) */
  clears: boolean;
}

/**
 * Whether a long-gamma overlay sized to offset the desk's short-gamma bleed clears its premium.
 * From the delta-hedged-option identity bleed ≈ ½Γσ_r²T, a matching long-gamma leg nets
 * ½Γ(σ_r²−σ_i²)T = bleed·(1 − σ_i²/σ_r²), minus the option cost.
 */
export function gammaOverlay(input: GammaOverlayInput): GammaOverlayResult {
  const { realizedVol: rv, impliedVol: iv, bleedUsd, costUsd = 0 } = input;
  const recoverFraction = rv > 0 ? 1 - (iv * iv) / (rv * rv) : 0;
  const recoveredUsd = bleedUsd * recoverFraction;
  const netUsd = recoveredUsd - costUsd;
  return { recoverFraction, recoveredUsd, netUsd, clears: netUsd > 0 };
}

/** Direct variance form: a constant cash-gamma G (= S²Γ) held T years nets ½G(σr²−σi²)T. */
export function variancePnlUsd(cashGammaUsd: number, realizedVol: number, impliedVol: number, years: number): number {
  return 0.5 * cashGammaUsd * (realizedVol * realizedVol - impliedVol * impliedVol) * years;
}
