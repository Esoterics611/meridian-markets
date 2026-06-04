// EventLoopMonitor — samples event-loop lag (scheduling delay) by scheduling a
// timer for `intervalMs` and measuring how late it actually fires; the overshoot
// is the lag. Reports it (seconds) to a callback so PrometheusTelemetry can set a
// gauge. The timer is `unref()`'d so it never holds the process open, and it is
// only started when telemetry is enabled — so a NullTelemetry run has no timer at
// all (zero overhead, DC-5). Lifecycle-managed: stop() clears it (no leaked
// handles in tests or on shutdown).
export class EventLoopMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;

  constructor(
    private readonly onLagSeconds: (seconds: number) => void,
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const drift = now - this.last - this.intervalMs;
      this.last = now;
      this.onLagSeconds(Math.max(0, drift) / 1000);
    }, this.intervalMs);
    // Don't keep the process alive just to measure lag.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
