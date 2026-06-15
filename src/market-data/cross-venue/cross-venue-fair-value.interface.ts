import { L2Snapshot } from '../reference/reference-source.interface';

// CrossVenueFairValue — the T1 foundation of the Profit Pivot (PROFIT_PIVOT.md §3).
// Anchors fair value to Binance (the price leader), measures the HL↔Binance basis
// and the age of HL's book data in real time. MEASURE-ONLY first: nothing in P1
// trades on this; it validates the ~100ms HL-lags-Binance claim before anything
// depends on it (PROFIT_PIVOT.md §3 T1 gate + §5 honesty gate #1).
//
// Swap-seam discipline (CLAUDE.md §7): interface + real + mock, safe default.

export interface BasisSnapshot {
  symbol: string;
  capturedAtMs: number;
  /** Binance last-trade price (the leading fair value). */
  binanceMid: number;
  binanceFetchMs: number;
  /** HL best-bid/ask mid from the L2 snapshot. */
  hlMid: number;
  /** Server-side timestamp in the HL L2 response (Date.getTime()). */
  hlServerTsMs: number;
  /** Wall-clock time when the HL response was received. */
  hlFetchMs: number;
  /** hlMid − binanceMid (perp basis, price units). */
  basis: number;
  /** basis / binanceMid × 10 000 (signed, bps). */
  basisBps: number;
  /**
   * Age of HL's book data at capture time: hlFetchMs − hlServerTsMs.
   * When Binance and HL are sampled concurrently this ≈ hlServerTs lag + network RTT.
   * Positive means HL's reported data is that many ms stale from its own clock.
   */
  hlDataAgeMs: number;
  /** Full L2 snapshot for consumers that need the book (e.g. micro-price). */
  hlBook: L2Snapshot;
}

export interface ICrossVenueFairValue {
  /** Fetch a live Binance price + HL L2 snapshot concurrently and compute the basis. */
  getBasis(symbol: string): Promise<BasisSnapshot>;
}

// Mock — safe, configurable basis for unit tests and offline usage.
export class MockCrossVenueFairValue implements ICrossVenueFairValue {
  constructor(private readonly overrides: Partial<Omit<BasisSnapshot, 'symbol'>> = {}) {}

  async getBasis(symbol: string): Promise<BasisSnapshot> {
    const now = Date.now();
    const mid = this.overrides.binanceMid ?? 100;
    const basis = this.overrides.basis ?? 0;
    return {
      symbol,
      capturedAtMs: now,
      binanceMid: mid,
      binanceFetchMs: now,
      hlMid: mid + basis,
      hlServerTsMs: now - (this.overrides.hlDataAgeMs ?? 100),
      hlFetchMs: now,
      basis,
      basisBps: mid > 0 ? (basis / mid) * 10_000 : 0,
      hlDataAgeMs: this.overrides.hlDataAgeMs ?? 100,
      hlBook: this.overrides.hlBook ?? { symbol, ts: new Date(now), bids: [], asks: [] },
      ...this.overrides,
    };
  }
}
