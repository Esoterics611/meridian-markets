/**
 * maker-tape.types — the Phase-0 tape format for prediction-market maker research.
 *
 * scripts/orv-calibration.ts writes these records (JSONL, one file per UTC day);
 * scripts/orv-maker-replay.ts and the calibration scorer read them back. Everything a
 * maker simulation or Brier scorer needs is ON the record — replays never re-fetch.
 * See docs/PREDICTION_MARKET_MM_RESEARCH.md §5 (Phase 0).
 */

/** [price, size] — one displayed L2 level, prices in probability units. */
export type TapeLevel = [number, number];

export interface TapeSnap {
  ev: 'SNAP';
  ms: number;
  marketId: string;
  underlying: string;
  targetPrice: number;
  expiryMs: number;
  /** Live-spot smile-adjusted fair (recomputed every tick off the venue perp mid). */
  fairYes: number;
  naive: number;
  d2: number;
  tYears: number;
  iv: number;
  /** HL perp mid used as spot for this tick's fair. */
  hlMid: number;
  /** allMids value for the NO side (complement check: yesMid + noMid ≈ 1). */
  noMid: number | null;
  /** Age of the Deribit smile behind iv/skew at this tick. */
  smileAgeMs: number;
  /** YES-book depth, best-first. */
  bids: TapeLevel[];
  asks: TapeLevel[];
}

export interface TapeSettle {
  ev: 'SETTLE';
  ms: number;
  marketId: string;
  underlying: string;
  targetPrice: number;
  expiryMs: number;
  /** Venue underlying mid sampled at the first tick ≥ expiry. */
  spotAtExpiry: number;
  settledYes: boolean;
  /** Honesty: HL settles on interpolated mark samples; this is our mid approximation. */
  oracle: 'hl-mid-approx';
}

export type TapeRecord = TapeSnap | TapeSettle;

/** Parse one JSONL line into a TapeRecord, or null for non-tape lines (BOOT/SUMMARY/…). */
export function parseTapeLine(line: string): TapeRecord | null {
  const s = line.trim();
  if (!s) return null;
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  const ev = (o as { ev?: string }).ev;
  if (ev === 'SNAP' || ev === 'SETTLE') return o as TapeRecord;
  return null;
}
