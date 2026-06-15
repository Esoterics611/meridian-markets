import { BasisSnapshot } from './cross-venue-fair-value.interface';

// CrossVenueBasisArb — T4 of the Profit Pivot (PROFIT_PIVOT.md §3 T4).
// Detects when the HL↔Binance basis exceeds fees + a margin (a REAL dislocation —
// vol spikes, listings, liquidation cascades) and classifies the entry direction.
//
// The report is explicit: sub-second arms race for micro-noise is not ours, but
// LARGER, SLOWER dislocations don't hinge on ~100ms and ARE accessible to a paper
// desk with holding capacity (PROFIT_PIVOT.md §1 + §3 T4). P1 = DETECT AND LOG ONLY.
// Actual arb entry is gated: only fire above fee+slippage; cap holding time; measure
// convergence hit-rate on the first forward paper window before sizing up.
//
// Swap-seam (CLAUDE.md §7): interface + real + mock, safe default = null (no signals).

/** Direction of the basis arb entry. */
export type BasisArbDirection = 'LONG_HL_SHORT_BINANCE' | 'LONG_BINANCE_SHORT_HL';

export interface BasisArbSignal {
  symbol: string;
  capturedAtMs: number;
  direction: BasisArbDirection;
  /** Signed basis at detection: hlMid − binanceMid, bps. */
  entryBasisBps: number;
  /** Total round-trip fee cost in bps (both legs, entry + exit). */
  roundTripCostBps: number;
  /** Margin above fees for which this signal fires: |basisBps| − roundTripCostBps. */
  netEdgeBps: number;
  /** The basis threshold this signal was triggered by. */
  thresholdBps: number;
  /** T1 snapshot that produced this signal. */
  snapshot: BasisSnapshot;
}

export interface ICrossVenueBasisArb {
  /**
   * Check a live basis snapshot for a dislocation. Returns a signal when
   * |basisBps| > thresholdBps, null otherwise. Pure, no state.
   */
  check(snapshot: BasisSnapshot): BasisArbSignal | null;
  /** Threshold in bps above which a dislocation signal fires. */
  readonly thresholdBps: number;
}

/** No-signal mock — the safe offline default. */
export class MockCrossVenueBasisArb implements ICrossVenueBasisArb {
  readonly thresholdBps: number;
  constructor(thresholdBps = 19) {
    this.thresholdBps = thresholdBps;
  }
  check(_snapshot: BasisSnapshot): BasisArbSignal | null {
    return null;
  }
}
