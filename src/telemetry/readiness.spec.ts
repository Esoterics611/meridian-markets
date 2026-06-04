import { assessReadiness, ReadinessInput } from './readiness';

const base: ReadinessInput = {
  persistEnabled: false,
  dbReachable: null,
  deskRunning: false,
  bookCount: 0,
  lastTickAgeMs: null,
  pollIntervalMs: 15_000,
  readyTickMultiplier: 5,
  bookBarAgesMs: [],
  feedStalenessMs: 120_000,
};

describe('assessReadiness (FR-8)', () => {
  it('an idle process with persistence off is ready (can accept work)', () => {
    const r = assessReadiness(base);
    expect(r.ready).toBe(true);
    expect(r.checks).toEqual([]);
  });

  it('persistence on + DB unreachable is NOT ready', () => {
    const r = assessReadiness({ ...base, persistEnabled: true, dbReachable: false });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === 'database')!.ok).toBe(false);
  });

  it('persistence on + DB reachable + idle is ready', () => {
    const r = assessReadiness({ ...base, persistEnabled: true, dbReachable: true });
    expect(r.ready).toBe(true);
  });

  it('running but stale tick (older than N×poll) is NOT ready', () => {
    const r = assessReadiness({
      ...base,
      deskRunning: true,
      bookCount: 1,
      lastTickAgeMs: 15_000 * 5 + 1,
      bookBarAgesMs: [1000],
    });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === 'tick_loop')!.ok).toBe(false);
  });

  it('running with a fresh tick + fresh bar is ready', () => {
    const r = assessReadiness({
      ...base,
      deskRunning: true,
      bookCount: 1,
      lastTickAgeMs: 2000,
      bookBarAgesMs: [3000],
    });
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(['tick_loop', 'feed']);
  });

  it('running with all feeds stale is NOT ready', () => {
    const r = assessReadiness({
      ...base,
      deskRunning: true,
      bookCount: 2,
      lastTickAgeMs: 1000,
      bookBarAgesMs: [200_000, 300_000],
    });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === 'feed')!.ok).toBe(false);
  });

  it('a just-launched book with no bar yet is treated as warming, not a failure', () => {
    const r = assessReadiness({
      ...base,
      deskRunning: true,
      bookCount: 1,
      lastTickAgeMs: 1000,
      bookBarAgesMs: [], // no bars produced yet
    });
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.name === 'feed')!.detail).toMatch(/warming/);
  });

  it('never ticked while running is NOT ready', () => {
    const r = assessReadiness({ ...base, deskRunning: true, bookCount: 1, lastTickAgeMs: null });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === 'tick_loop')!.detail).toMatch(/no tick yet/);
  });
});
