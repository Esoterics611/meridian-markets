// GapDetector — pure-function gap detection over a sequence of bars.
// Walks an ascending-by-timestamp series and flags any inter-bar interval
// strictly greater than the expected bar interval. Returns one Gap per
// detected hole; the caller persists them into data_gaps.

export interface Gap {
  /** Timestamp of the bar BEFORE the gap. */
  gapStart: Date;
  /** Timestamp of the bar AFTER the gap. */
  gapEnd: Date;
  /** Number of bars missing between gapStart and gapEnd. */
  missingBars: number;
}

export function detectGaps(
  timestamps: Date[],
  expectedIntervalMs: number,
): Gap[] {
  if (expectedIntervalMs <= 0) {
    throw new Error('detectGaps: expectedIntervalMs must be > 0');
  }
  const gaps: Gap[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i].getTime() - timestamps[i - 1].getTime();
    if (dt <= expectedIntervalMs) continue; // contiguous or duplicate-handled separately
    const missing = Math.round(dt / expectedIntervalMs) - 1;
    if (missing <= 0) continue;
    gaps.push({
      gapStart: timestamps[i - 1],
      gapEnd: timestamps[i],
      missingBars: missing,
    });
  }
  return gaps;
}
