// VpinEstimator — running Volume-Synchronised Probability of Informed Trading
// (course §2.7, Appendix A.9, after ELO12). VPIN buckets trade volume into
// fixed-size bins and tracks the buy/sell imbalance per bucket; a sustained
// one-sided imbalance is the signature of toxic (informed) flow, and the risk
// gate uses it to *pause* quoting before the toxic fills pile up.
//
// Intentionally simple — an EMA of |V_B − V_S|/(V_B + V_S) across buckets —
// because the elaborate variants don't predict adverse-selection cost any
// better (Andersen-Bondarenko 2014) and the simple one is auditable. Trade-side
// classification (Lee-Ready / tick rule / BVC) is the caller's job; this only
// consumes a pre-classified side.

export interface VpinConfig {
  /** Volume per bucket, in asset units. */
  readonly bucketVolumeUnits: bigint;
  /** EMA window in buckets; typical 50. */
  readonly emaWindowBuckets: number;
}

export class VpinEstimator {
  private bucketBuyUnits = 0n;
  private bucketSellUnits = 0n;
  private emaVpin = 0;
  private buckets = 0;

  constructor(private readonly cfg: VpinConfig) {
    if (cfg.bucketVolumeUnits <= 0n) throw new Error('VpinEstimator: bucketVolumeUnits must be > 0');
  }

  onTrade(sizeUnits: bigint, side: 'buy' | 'sell'): void {
    if (sizeUnits <= 0n) return;
    if (side === 'buy') this.bucketBuyUnits += sizeUnits;
    else this.bucketSellUnits += sizeUnits;

    while (this.bucketBuyUnits + this.bucketSellUnits >= this.cfg.bucketVolumeUnits) {
      const total = this.bucketBuyUnits + this.bucketSellUnits;
      const imbalanceUnits =
        this.bucketBuyUnits > this.bucketSellUnits
          ? this.bucketBuyUnits - this.bucketSellUnits
          : this.bucketSellUnits - this.bucketBuyUnits;
      const imbalance = Number(imbalanceUnits) / Number(total);
      const alpha = 2 / (this.cfg.emaWindowBuckets + 1);
      this.emaVpin = this.buckets === 0 ? imbalance : alpha * imbalance + (1 - alpha) * this.emaVpin;
      this.buckets += 1;
      // Carry the overflow into the next bucket (don't drop it).
      const overflow = total - this.cfg.bucketVolumeUnits;
      if (this.bucketBuyUnits >= this.bucketSellUnits) {
        this.bucketBuyUnits = overflow;
        this.bucketSellUnits = 0n;
      } else {
        this.bucketSellUnits = overflow;
        this.bucketBuyUnits = 0n;
      }
    }
  }

  /** Current VPIN in [0,1]. */
  current(): number {
    return this.emaVpin;
  }

  bucketsSeen(): number {
    return this.buckets;
  }
}
