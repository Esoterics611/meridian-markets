// Fee-aware entry gate for the pairs (z-score) strategies.
//
// A pairs round-trip entered at standardised deviation |z| and exited at exitZ
// captures, in log-spread units, ≈ (|z| − exitZ)·σ_spread. With equal per-leg
// notional N (β≈1), the realised gross P&L is ≈ N·(|z| − exitZ)·σ_spread, while
// the round-trip costs 4 taker fills (open A+B, close A+B) at N·feeFraction each
// → 4·N·feeFraction. The notional cancels, so a trade is structurally profitable
// only when
//
//   (|z| − exitZ)·σ_spread  ≥  k · 4 · (feeBps / 10_000)
//
// where k ≥ 1 is a margin-of-safety multiple. This is the discipline the course
// names in §1.3 (the minimum profitable spread must clear 2×c_op per leg) and
// the reason a thin per-trade edge loses to fees. The OU/Bertram strategy bakes
// the same idea into its entry band via txCostFraction; this gives the z-score
// strategies the equivalent guard. It also routes sub-fee spreads (e.g. a
// stablecoin peg, σ tiny) AWAY from taker stat-arb and toward the maker
// market-making books, which earn the rebate instead of paying the taker fee.

/** Population stdev of a numeric window (matches the rolling z denominator). */
export function stdev(window: number[]): number {
  const n = window.length;
  if (n < 2) return 0;
  const mean = window.reduce((s, x) => s + x, 0) / n;
  const varc = window.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  return Math.sqrt(varc);
}

/** Expected captured move (log-spread fraction) reverting from |z| to exitZ. */
export function expectedEdgeFraction(zNow: number, exitZ: number, sigmaSpread: number): number {
  return Math.max(0, Math.abs(zNow) - exitZ) * sigmaSpread;
}

/** Round-trip fee as a fraction of per-leg notional (4 fills by default). */
export function roundTripFeeFraction(feeBps: number, legsPerRoundTrip = 4): number {
  return (feeBps / 10_000) * legsPerRoundTrip;
}

/**
 * Does the expected edge clear the round-trip fee (×safety multiple)?
 * Returns true (gate open) when feeBps ≤ 0 — the gate is disabled, preserving
 * the prior fee-blind behaviour for callers that don't opt in.
 */
export function entryClearsFees(
  zNow: number,
  exitZ: number,
  sigmaSpread: number,
  feeBps: number,
  minEdgeMultiple = 1,
): boolean {
  if (!(feeBps > 0)) return true;
  const edge = expectedEdgeFraction(zNow, exitZ, sigmaSpread);
  const cost = roundTripFeeFraction(feeBps) * Math.max(minEdgeMultiple, 0);
  return edge >= cost;
}
