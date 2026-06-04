// assessReadiness — the pure decision behind GET /health/ready (FR-8). Kept free
// of Nest/IO so it is exhaustively unit-testable; the HealthController just gathers
// the inputs (DB ping, desk snapshot, last-tick age) and calls this.
//
// Readiness is "can this process be trusted to run the desk right now", for an
// orchestrator:
//   - DB reachable WHEN persistence is on (a stuck DB threatens restart-safety).
//   - The tick loop is fresh WHEN the desk is running (last tick within N×poll).
//   - At least one feed is fresh WHEN running books have produced bars (a desk
//     whose every feed has gone stale is not ready). A just-launched, still-warming
//     book that has produced no bar yet is "pending", not a failure — so a cold
//     start isn't killed before its first bar.
// An idle process (nothing running, persistence off) is READY — it can accept work.

export interface ReadinessInput {
  persistEnabled: boolean;
  /** DB reachability when persistEnabled; null when not applicable / not checked. */
  dbReachable: boolean | null;
  deskRunning: boolean;
  bookCount: number;
  /** Age of the last completed tick (ms); null if the loop has never ticked. */
  lastTickAgeMs: number | null;
  pollIntervalMs: number;
  /** Stuck-loop multiple: not ready if last tick older than N×poll. */
  readyTickMultiplier: number;
  /** Bar ages (ms) for running books that have produced a bar; empty if none have. */
  bookBarAgesMs: number[];
  /** A feed is stale beyond this (ms). */
  feedStalenessMs: number;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: ReadinessCheck[];
}

export function assessReadiness(input: ReadinessInput): ReadinessResult {
  const checks: ReadinessCheck[] = [];

  if (input.persistEnabled) {
    const ok = input.dbReachable === true;
    checks.push({ name: 'database', ok, detail: ok ? 'reachable' : 'unreachable' });
  }

  if (input.deskRunning) {
    const limit = input.pollIntervalMs * input.readyTickMultiplier;
    const tickOk = input.lastTickAgeMs !== null && input.lastTickAgeMs <= limit;
    checks.push({
      name: 'tick_loop',
      ok: tickOk,
      detail:
        input.lastTickAgeMs === null
          ? 'no tick yet'
          : `last tick ${Math.round(input.lastTickAgeMs)}ms ago (limit ${limit}ms)`,
    });

    if (input.bookCount > 0) {
      // Only fail when bars EXIST and the freshest is stale; no bars yet ⇒ warming.
      if (input.bookBarAgesMs.length === 0) {
        checks.push({ name: 'feed', ok: true, detail: 'no bars yet (warming)' });
      } else {
        const freshestMs = Math.min(...input.bookBarAgesMs);
        const feedOk = freshestMs <= input.feedStalenessMs;
        checks.push({
          name: 'feed',
          ok: feedOk,
          detail: `freshest bar ${Math.round(freshestMs)}ms ago (limit ${input.feedStalenessMs}ms)`,
        });
      }
    }
  }

  const ready = checks.every((c) => c.ok);
  return { ready, checks };
}
