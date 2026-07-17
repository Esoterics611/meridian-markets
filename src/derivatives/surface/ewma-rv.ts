// EwmaRv — the #96 realized-vol fix (OPTIONS_DESK.md O-E2), shared by every options
// gate. The v0 VRP book measured RV over a rolling window of hourly closes; one stale
// print rolling OUT of the window moved RV 0.511 → 0.429 in a single minute with no
// market event, and the gate opened a position on the artifact. An EWMA has no window
// edges: every observation's influence decays geometrically (var_{t+1} = λ·var_t when
// nothing new happens), so a shock can only ENTER the estimate visibly — it can never
// leave it as a cliff. That property is spec-locked (ewma-rv.spec.ts).
//
// Units: log-returns in, ANNUALIZED vol (fraction, 0.37 = 37 vol) out. λ defaults to
// 0.97 for 1h bars — half-life ln(0.5)/ln(0.97) ≈ 23 bars ≈ one day, matching the 24h
// horizon the v0 window intended. Both knobs are per-instance; the collector records
// them on its BOOT line so a tape is always interpretable.

export class EwmaRv {
  /** Annualized variance state; undefined until the first update. */
  private variance: number | undefined;

  constructor(
    private readonly lambda = 0.97,
    private readonly barsPerYear = 24 * 365,
  ) {
    if (!(lambda > 0 && lambda < 1)) throw new Error(`EwmaRv: lambda must be in (0,1), got ${lambda}`);
    if (!(barsPerYear > 0)) throw new Error(`EwmaRv: barsPerYear must be > 0, got ${barsPerYear}`);
  }

  /** Feed one bar's log-return; returns the updated annualized vol. */
  update(logReturn: number): number {
    const r2 = logReturn * logReturn * this.barsPerYear;
    this.variance = this.variance === undefined ? r2 : this.lambda * this.variance + (1 - this.lambda) * r2;
    return Math.sqrt(this.variance);
  }

  /** Seed from a history of closes (oldest → newest); returns the seeded vol or undefined if < 2 closes. */
  seed(closes: number[]): number | undefined {
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1];
      const cur = closes[i];
      if (prev > 0 && cur > 0) this.update(Math.log(cur / prev));
    }
    return this.rv;
  }

  /** Annualized vol (fraction), or undefined before any update. */
  get rv(): number | undefined {
    return this.variance === undefined ? undefined : Math.sqrt(this.variance);
  }
}
