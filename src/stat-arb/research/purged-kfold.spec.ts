import { purgedKFoldSplits } from './purged-kfold';

describe('purgedKFoldSplits', () => {
  it('produces `folds` splits whose test blocks tile [0,n) exactly', () => {
    const splits = purgedKFoldSplits(100, 5, 0);
    expect(splits.length).toBe(5);
    // Test blocks are contiguous and cover everything with no overlap.
    let expectedStart = 0;
    const allTest = new Set<number>();
    for (const s of splits) {
      expect(s.testStart).toBe(expectedStart);
      for (const i of s.testIdx) allTest.add(i);
      expectedStart = s.testEnd;
    }
    expect(expectedStart).toBe(100);
    expect(allTest.size).toBe(100);
  });

  it('distributes the remainder so blocks still cover an indivisible n', () => {
    const splits = purgedKFoldSplits(103, 5, 0);
    const total = splits.reduce((s, sp) => s + sp.testIdx.length, 0);
    expect(total).toBe(103);
    expect(splits[splits.length - 1].testEnd).toBe(103);
  });

  it('with zero embargo, train is exactly the complement of the test fold', () => {
    const splits = purgedKFoldSplits(50, 5, 0);
    for (const s of splits) {
      expect(s.trainIdx.length + s.testIdx.length).toBe(50);
      // No index is in both.
      const testSet = new Set(s.testIdx);
      for (const i of s.trainIdx) expect(testSet.has(i)).toBe(false);
    }
  });

  it('embargo removes train bars adjacent to the test fold (purge before + embargo after)', () => {
    const noGap = purgedKFoldSplits(100, 5, 0);
    const withGap = purgedKFoldSplits(100, 5, 0.05); // 5-bar gap each side
    // Take an interior fold so there is train on both sides to purge/embargo.
    const i = 2;
    expect(withGap[i].trainIdx.length).toBeLessThan(noGap[i].trainIdx.length);
    const { testStart, testEnd } = withGap[i];
    const gap = 5;
    for (const idx of withGap[i].trainIdx) {
      const insideGap = idx >= testStart - gap && idx < testEnd + gap;
      expect(insideGap).toBe(false);
    }
  });

  it('train indices are strictly ascending', () => {
    for (const s of purgedKFoldSplits(80, 4, 0.02)) {
      for (let k = 1; k < s.trainIdx.length; k++) {
        expect(s.trainIdx[k]).toBeGreaterThan(s.trainIdx[k - 1]);
      }
    }
  });

  it('rejects fewer than 2 folds and n < folds', () => {
    expect(() => purgedKFoldSplits(100, 1)).toThrow(/2 folds/);
    expect(() => purgedKFoldSplits(3, 5)).toThrow(/n must be/);
  });
});
