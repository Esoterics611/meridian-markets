import { cointegrationTest, CointegrationResult } from './cointegration';

// SlidingCointegration — re-fits the Engle-Granger two-step test on a rolling
// window so β tracks regime changes instead of being pinned at construction.
//
// Output is a sparse series: one entry per refit index. The strategy reads
// the latest entry on each bar via `latestAsOf(index)`.

export interface SlidingCointegrationResult extends CointegrationResult {
  /** Bar index at which this refit was computed. The fit uses bars [fittedAtIndex - windowBars + 1 .. fittedAtIndex]. */
  fittedAtIndex: number;
}

export function slidingCointegration(
  logA: number[],
  logB: number[],
  windowBars: number,
  refitEveryBars: number,
): SlidingCointegrationResult[] {
  if (logA.length !== logB.length) {
    throw new Error('slidingCointegration: logA and logB must have same length');
  }
  if (windowBars < 10) {
    throw new Error('slidingCointegration: windowBars must be >= 10');
  }
  if (refitEveryBars < 1) {
    throw new Error('slidingCointegration: refitEveryBars must be >= 1');
  }
  const out: SlidingCointegrationResult[] = [];
  for (let end = windowBars - 1; end < logA.length; end += refitEveryBars) {
    const start = end - windowBars + 1;
    const sliceA = logA.slice(start, end + 1);
    const sliceB = logB.slice(start, end + 1);
    const fit = cointegrationTest(sliceA, sliceB);
    out.push({ ...fit, fittedAtIndex: end });
  }
  return out;
}

/** Returns the most recent refit whose fittedAtIndex <= asOfIndex, or null. */
export function latestAsOf(
  fits: SlidingCointegrationResult[],
  asOfIndex: number,
): SlidingCointegrationResult | null {
  let best: SlidingCointegrationResult | null = null;
  for (const f of fits) {
    if (f.fittedAtIndex <= asOfIndex) best = f;
    else break;
  }
  return best;
}
