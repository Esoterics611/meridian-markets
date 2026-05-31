// RollingVolatility — per-bar realised volatility from a rolling window of
// closes, expressed as a fraction of price (the unit QuoteContext.volatility
// wants). The market-making spread and the Avellaneda-Stoikov inventory term
// are both proportional to σ, so the quoters need a live σ estimate; this is
// the cheap bar-data version (the honest tick-data version uses trade prints,
// a §6 upgrade that lands with the LOB tape).
//
// σ is the sample standard deviation of one-bar log returns over the window.
// Returns NaN until at least `window` returns are available, mirroring the
// z-score / OU warmup convention in the stat-arb signal layer.

export class RollingVolatility {
  private readonly closes: number[] = [];

  constructor(private readonly window: number) {
    if (window < 2) throw new Error('RollingVolatility: window must be >= 2');
  }

  push(close: number): void {
    if (!Number.isFinite(close) || close <= 0) return;
    this.closes.push(close);
    // Keep window+1 closes so we can form `window` log returns.
    const cap = this.window + 1;
    if (this.closes.length > cap) this.closes.splice(0, this.closes.length - cap);
  }

  ready(): boolean {
    return this.closes.length >= this.window + 1;
  }

  /** Sample stdev of log returns over the window, or NaN until warm. */
  value(): number {
    if (!this.ready()) return NaN;
    const rets: number[] = [];
    for (let i = 1; i < this.closes.length; i++) {
      rets.push(Math.log(this.closes[i] / this.closes[i - 1]));
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varc = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(varc);
  }

  /** σ with a positive floor — quoters should never see σ=0 (degenerate spread). */
  valueOr(floor: number): number {
    const v = this.value();
    return Number.isFinite(v) && v > floor ? v : floor;
  }
}
