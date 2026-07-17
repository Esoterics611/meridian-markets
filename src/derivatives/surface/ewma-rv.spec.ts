import { EwmaRv } from './ewma-rv';

// O-E2 spec — locks the #96 fix in (CLAUDE.md §10.1-2): the estimator must have no
// window edges. The artifact class it kills: a rolling-window RV where one old print
// leaving the window moves the estimate discontinuously (0.511 → 0.429 in one minute,
// journal #96) with no new information.

describe('EwmaRv (the #96 realized-vol fix)', () => {
  it('is undefined before any update, defined after', () => {
    const e = new EwmaRv();
    expect(e.rv).toBeUndefined();
    e.update(0.001);
    expect(e.rv).toBeGreaterThan(0);
  });

  it('annualizes correctly: constant |log-return| r per bar converges to r·√barsPerYear', () => {
    const barsPerYear = 24 * 365;
    const e = new EwmaRv(0.97, barsPerYear);
    const r = 0.002; // 20bps per 1h bar
    for (let i = 0; i < 2000; i++) e.update(i % 2 === 0 ? r : -r);
    expect(e.rv!).toBeCloseTo(r * Math.sqrt(barsPerYear), 6);
  });

  it('NO window-edge cliff: after a shock, with no further news the estimate decays geometrically (var·λ per bar), never jumps', () => {
    const lambda = 0.97;
    const e = new EwmaRv(lambda, 24 * 365);
    for (let i = 0; i < 200; i++) e.update(i % 2 === 0 ? 0.001 : -0.001); // calm baseline
    e.update(0.05); // the stale-print / cascade shock enters
    let prevVar = e.rv! ** 2;
    for (let i = 0; i < 50; i++) {
      e.update(0); // no further information
      const curVar = e.rv! ** 2;
      // exactly var·λ — the shock's influence LEAVES smoothly, one decay factor per bar
      expect(curVar).toBeCloseTo(prevVar * lambda, 10);
      prevVar = curVar;
    }
  });

  it('a single outlier cannot swing the estimate by more than (1−λ) of its own weight — the gate-artifact bound', () => {
    const lambda = 0.97;
    const e = new EwmaRv(lambda, 24 * 365);
    for (let i = 0; i < 500; i++) e.update(i % 2 === 0 ? 0.002 : -0.002);
    const before = e.rv! ** 2;
    e.update(0.05); // one bad print
    const after = e.rv! ** 2;
    const outlierVar = 0.05 * 0.05 * 24 * 365;
    expect(after - before).toBeCloseTo((1 - lambda) * (outlierVar - before), 8);
  });

  it('seeds from a close series (oldest → newest), skipping non-positive prices', () => {
    const e = new EwmaRv(0.97, 24 * 365);
    const closes = [100, 100.2, 99.9, 0, 100.1, 100.3]; // one bad print in the history
    const rv = e.seed(closes);
    expect(rv).toBeGreaterThan(0);
    expect(rv).toBe(e.rv);
  });

  it('rejects degenerate constructor inputs', () => {
    expect(() => new EwmaRv(0)).toThrow();
    expect(() => new EwmaRv(1)).toThrow();
    expect(() => new EwmaRv(0.97, 0)).toThrow();
  });
});
