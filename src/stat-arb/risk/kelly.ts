// Kelly sizing. The classic formula is f* = edge / variance, in units of
// "fraction of capital". For a stat-arb pairs trade:
//   edge     — expected return per unit of notional held (e.g. 0.005 = 50 bps)
//   variance — sample variance of that return distribution (per-trade)
//
// Production desks scale by 0.5 (half-Kelly) because the variance estimate is
// always too low in finite samples; full Kelly bankrupts you when σ̂ underestimates σ.

export const HALF_KELLY = 0.5;

export interface KellyInputs {
  edge: number;
  variance: number;
}

/** Raw Kelly fraction. Clamped to [0, 1]; returns 0 on non-positive edge or non-finite inputs. */
export function kellyFraction(edge: number, variance: number): number {
  if (!Number.isFinite(edge) || !Number.isFinite(variance)) return 0;
  if (edge <= 0) return 0;
  if (variance <= 0) return 0;
  const raw = edge / variance;
  if (raw <= 0) return 0;
  return Math.min(1, raw);
}

/**
 * Half-Kelly notional in 6-decimal USDC units.
 *   capital       — total capital available (USDC units)
 *   edge, variance — see kellyFraction
 *   volMultiplier — additional vol-target shrinkage. Defaults to 1.
 *
 * Returns 0n on zero edge, zero variance, zero capital, or non-finite inputs.
 */
export function halfKellyNotional(
  capital: bigint,
  edge: number,
  variance: number,
  volMultiplier = 1,
): bigint {
  if (capital <= 0n) return 0n;
  if (!Number.isFinite(volMultiplier) || volMultiplier <= 0) return 0n;
  const f = kellyFraction(edge, variance);
  const scaled = f * HALF_KELLY * volMultiplier;
  if (scaled <= 0) return 0n;
  // Convert bigint capital → float, multiply, back to bigint. Safe because
  // capital is bounded by realistic balance sizes (well under 2^53).
  const sized = BigInt(Math.floor(Number(capital) * Math.min(1, scaled)));
  return sized < 0n ? 0n : sized;
}
