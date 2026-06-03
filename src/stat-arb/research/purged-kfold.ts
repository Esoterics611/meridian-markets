// Purged k-fold cross-validation splits (López de Prado, AFML ch. 7).
//
// Plain k-fold leaks in a time series: a strategy whose state/labels span
// several bars sees train observations that overlap the test fold, inflating
// the OOS score. Purged k-fold fixes that by (1) PURGING train bars adjacent to
// the test fold (their information overlaps the test window) and (2) adding an
// EMBARGO of train bars immediately AFTER the test fold (serial correlation
// leaks forward). Each fold serves as the test set once; train is everything
// else minus the purge+embargo gap.
//
// Returned indices are into the original 0..n-1 bar sequence. Test folds are
// contiguous blocks (so the strategy can warm up + the replay venue can price a
// slice); train indices are the remaining bars, generally NON-contiguous.

export interface CvSplit {
  foldIndex: number;
  /** Contiguous test block [testStart, testEnd). */
  testStart: number;
  testEnd: number;
  /** Train indices (ascending), with the purge+embargo gap around the test block removed. */
  trainIdx: number[];
  testIdx: number[];
}

/**
 * Purged k-fold splits over n observations.
 * @param n           number of observations
 * @param folds       number of folds (>=2)
 * @param embargoFrac fraction of n to purge/embargo on each side of the test block (default 1%)
 */
export function purgedKFoldSplits(n: number, folds: number, embargoFrac = 0.01): CvSplit[] {
  if (folds < 2) throw new Error('purgedKFoldSplits: need at least 2 folds');
  if (n < folds) throw new Error('purgedKFoldSplits: n must be >= folds');
  const gap = Math.max(0, Math.floor(embargoFrac * n));
  const base = Math.floor(n / folds);
  const remainder = n % folds;

  const splits: CvSplit[] = [];
  let cursor = 0;
  for (let f = 0; f < folds; f++) {
    // Distribute the remainder across the first folds so blocks cover [0,n) exactly.
    const size = base + (f < remainder ? 1 : 0);
    const testStart = cursor;
    const testEnd = cursor + size;
    cursor = testEnd;

    const purgeLo = testStart - gap; // purge before
    const embargoHi = testEnd + gap; // embargo after
    const trainIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= purgeLo && i < embargoHi) continue; // inside test block or its gap
      trainIdx.push(i);
    }
    const testIdx: number[] = [];
    for (let i = testStart; i < testEnd; i++) testIdx.push(i);
    splits.push({ foldIndex: f, testStart, testEnd, trainIdx, testIdx });
  }
  return splits;
}
