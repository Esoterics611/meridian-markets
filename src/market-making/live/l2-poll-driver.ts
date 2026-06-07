import { IL2BookSource, ITradeStream, L2Snapshot } from '../../market-data/reference/reference-source.interface';
import { IntervalFlowLike } from '../backtest/l2-tape';
import { LiveTick } from './l2-fill-engine-types';

// (LiveTick is the shared input shape — see l2-fill-engine-types.ts.)

// L2PollDriver — the fast L2 poll loop that feeds the queue-aware live engine
// (l2-live-fill-engine.ts). It polls IL2BookSource.l2Snapshot for N symbols on a
// SUB-SECOND interval, parallel per symbol, best-effort (a failed poll skips that
// symbol's tick — never throws, never tears down the loop), and hands each fresh
// snapshot (+ its drained aggressor flow, when a trade stream is wired) to a
// per-symbol sink. This is the live-loop analogue of scripts/mm-l2-session.ts's
// poll loop, but as a cleanly start/stop-able component (no leaked timers) with an
// injected clock + scheduler so a unit test drives it deterministically with no
// network and no real time (CLAUDE.md test discipline).
//
// WHY A SEPARATE DRIVER: the cadence is the lever (§6b). The bar-driven mm-book
// re-quotes off 15s closed bars; this driver re-quotes off live depth every few
// hundred ms — the cadence at which the micro-price center + small markout horizon
// actually beat adverse selection. Keeping it a standalone driver means the engine
// stays a pure per-snapshot function (testable in isolation) and the driver owns
// only the timing + transport + rate-limit posture.
//
// RATE-LIMIT POSTURE (mirrors the capture script): every symbol is polled
// CONCURRENTLY per tick (Promise.all), so the cadence is bounded by ONE fetch
// (~hundreds of ms) rather than the sum across symbols; a slow/failed fetch for one
// symbol never delays the others or the next tick. The interval is wall-clock spaced
// by the injected scheduler; an in-flight tick is skipped if the previous one hasn't
// returned (no pile-up), the same guard the portfolio trader uses.

/** Receives each fresh snapshot + flow for a symbol. The engine's onSnapshot fits this. */
export type LiveTickSink = (symbol: string, tick: LiveTick) => void;

/** Drains accumulated aggressor flow for a symbol since the last poll (real trades-WS). */
export type FlowDrain = (symbol: string) => IntervalFlowLike | undefined;

/** Injected scheduler so tests drive the loop with a fake clock (no real setInterval). */
export interface PollScheduler {
  /** Schedule `fn` to run every `ms`; returns a handle. */
  setInterval(fn: () => void, ms: number): unknown;
  /** Cancel a handle from setInterval. */
  clearInterval(handle: unknown): void;
  /** Current epoch ms (the snapshot timestamp clock when the source omits one). */
  now(): number;
}

/** The real wall-clock scheduler (Node timers). The module injects this; tests inject a fake. */
export const REAL_POLL_SCHEDULER: PollScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export interface L2PollDriverConfig {
  source: IL2BookSource;
  /**
   * Symbols to poll: a fixed list, or a provider resolved fresh each cycle so the
   * driver tracks books launched/removed at runtime (the live desk's books are
   * dynamic). The provider form is what the portfolio trader passes.
   */
  symbols: string[] | (() => string[]);
  /** Poll cadence in ms (sub-second — ~250–1000ms). The §6b fast-requote lever. */
  pollIntervalMs: number;
  /** Where each fresh snapshot + flow is delivered (the live engine's onSnapshot). */
  sink: LiveTickSink;
  /** Optional aggressor-flow stream to drain per symbol per poll (real taker flow). */
  tradeStream?: ITradeStream;
  /** Injected scheduler (default = real Node timers). Tests pass a fake clock. */
  scheduler?: PollScheduler;
}

export class L2PollDriver {
  private readonly cfg: L2PollDriverConfig;
  private readonly scheduler: PollScheduler;
  private handle: unknown = null;
  private polling = false;
  private polls = 0;
  private snapshotsDelivered = 0;
  private failedPolls = 0;
  private lastPollAtMs: number | null = null;

  constructor(cfg: L2PollDriverConfig) {
    this.cfg = cfg;
    this.scheduler = cfg.scheduler ?? REAL_POLL_SCHEDULER;
  }

  /** Start the poll loop. Idempotent — a second start is a no-op while running. */
  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
  }

  /** Stop the poll loop and release the timer (no leaked timers). Idempotent. */
  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  /**
   * One poll cycle: fetch every symbol's L2 CONCURRENTLY, best-effort, and deliver each
   * fresh snapshot + drained flow to the sink. Never throws — a per-symbol fetch error
   * is swallowed (that symbol simply skips this tick). Skips entirely if a prior cycle is
   * still in flight (no pile-up). Exposed (not private) so a test can await one cycle.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPollAtMs = this.scheduler.now();
    const symbols = typeof this.cfg.symbols === 'function' ? this.cfg.symbols() : this.cfg.symbols;
    try {
      await Promise.all(
        symbols.map(async (symbol) => {
          const snap = await this.cfg.source.l2Snapshot(symbol).catch(() => undefined);
          if (!snap) {
            this.failedPolls += 1;
            return;
          }
          // Drain real aggressor flow for this symbol since the last poll (undefined ⇒
          // depth-only tick; the engine then re-quotes + decays the queue but books no
          // fills, exactly as a tape step with zero flow). Best-effort: a drain error
          // degrades to depth-only, it never sinks the tick.
          let flow: IntervalFlowLike | undefined;
          if (this.cfg.tradeStream) {
            try {
              const f = this.cfg.tradeStream.drain(symbol);
              if (f.tradeCount > 0) {
                flow = {
                  aggressiveBuyUnits: f.aggressiveBuyUnits,
                  aggressiveSellUnits: f.aggressiveSellUnits,
                  tradedHighMicros: f.highMicros,
                  tradedLowMicros: f.lowMicros,
                };
              }
            } catch {
              flow = undefined;
            }
          }
          this.snapshotsDelivered += 1;
          this.cfg.sink(symbol, { snapshot: this.stampTs(snap), flow });
        }),
      );
    } finally {
      this.polls += 1;
      this.polling = false;
    }
  }

  /** Use the source's snapshot ts when present; else stamp the injected clock (deterministic in tests). */
  private stampTs(snap: L2Snapshot): L2Snapshot {
    if (snap.ts instanceof Date && !Number.isNaN(snap.ts.getTime())) return snap;
    return { ...snap, ts: new Date(this.scheduler.now()) };
  }

  stats(): { polls: number; snapshotsDelivered: number; failedPolls: number; lastPollAtMs: number | null; running: boolean } {
    return {
      polls: this.polls,
      snapshotsDelivered: this.snapshotsDelivered,
      failedPolls: this.failedPolls,
      lastPollAtMs: this.lastPollAtMs,
      running: this.isRunning(),
    };
  }
}
