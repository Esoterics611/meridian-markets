import { BasisSnapshot } from './cross-venue-fair-value.interface';
import { BasisArbDirection, BasisArbSignal, ICrossVenueBasisArb } from './cross-venue-basis-arb.interface';

export interface CrossVenueBasisArbConfig {
  /**
   * Combined round-trip fee cost in bps (Binance taker + HL taker, both legs).
   * Default: Binance taker 4.5bps + HL taker 2.5bps × 2 legs = 14bps.
   */
  roundTripCostBps?: number;
  /**
   * Extra margin above fees required to fire a signal (buffer for slippage + spread).
   * Default 5bps. A signal fires when |basisBps| > roundTripCostBps + marginBps.
   */
  marginBps?: number;
}

/** Computes threshold = roundTripCostBps + marginBps. */
export function computeThreshold(roundTripCostBps: number, marginBps: number): number {
  return roundTripCostBps + marginBps;
}

export class CrossVenueBasisArbDetector implements ICrossVenueBasisArb {
  readonly thresholdBps: number;
  private readonly roundTripCostBps: number;

  constructor(cfg: CrossVenueBasisArbConfig = {}) {
    this.roundTripCostBps = cfg.roundTripCostBps ?? 14;
    const margin = cfg.marginBps ?? 5;
    this.thresholdBps = computeThreshold(this.roundTripCostBps, margin);
  }

  check(snapshot: BasisSnapshot): BasisArbSignal | null {
    const abs = Math.abs(snapshot.basisBps);
    if (abs <= this.thresholdBps) return null;

    // HL below Binance (negative basis) → BUY cheap HL / SELL rich Binance.
    // HL above Binance (positive basis) → BUY cheap Binance / SELL rich HL.
    const direction: BasisArbDirection = snapshot.basis < 0 ? 'LONG_HL_SHORT_BINANCE' : 'LONG_BINANCE_SHORT_HL';

    return {
      symbol: snapshot.symbol,
      capturedAtMs: snapshot.capturedAtMs,
      direction,
      entryBasisBps: snapshot.basisBps,
      roundTripCostBps: this.roundTripCostBps,
      netEdgeBps: abs - this.roundTripCostBps,
      thresholdBps: this.thresholdBps,
      snapshot,
    };
  }
}
