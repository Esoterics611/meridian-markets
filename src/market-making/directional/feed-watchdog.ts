// feed-watchdog + alerting — data-integrity protection for the "take sides" desk (Playbook II P15).
// Bad data is a silent killer: a stale tick freezes a position into a moving market, a price
// spike/outlier mis-marks the book, and a cross-venue divergence means one feed is lying. The
// FeedWatchdog detects all three and drives the RegimeMonitor's `feedStale` ⇒ STAND_ASIDE (the one
// input nothing computed before). The AlertDispatcher fans the desk's already-existing trigger
// events (stop-hit, desk HALT, feed-stale, DD-budget breach) out to ONE alert channel, firing
// EXACTLY ONCE per triggering condition. Both pure/guarded; the sink defaults to a no-op so a desk
// with no webhook configured behaves exactly as before.

export interface FeedWatchdogConfig {
  /** No update within this many ms ⇒ STALE. Default 3× a 60s poll = 180s. */
  readonly maxStaleMs?: number;
  /** |price/lastPrice − 1| above this ⇒ GAP/outlier. Default 0.10 (10% one-tick jump). */
  readonly maxGapFrac?: number;
  /** |price/crossVenuePrice − 1| above this ⇒ cross-venue DIVERGENCE. Default 0.02 (200bp). */
  readonly maxDivergenceFrac?: number;
}

export interface FeedHealth {
  readonly stale: boolean;
  readonly gap: boolean;
  readonly divergence: boolean;
  /** stale || gap || divergence — the flag wired into RegimeMonitor.feedStale. */
  readonly feedStale: boolean;
  readonly detail: string;
}

export interface FeedTick {
  readonly nowMs: number;
  readonly price: number;
  /** Optional cross-venue reference price (e.g. Binance vs HL) for the divergence check. */
  readonly crossVenuePrice?: number;
}

/** Per-symbol feed-health detector. Stateful (last tick) but pure + clock-free (nowMs passed in). */
export class FeedWatchdog {
  private readonly maxStaleMs: number;
  private readonly maxGapFrac: number;
  private readonly maxDivergenceFrac: number;
  private readonly last = new Map<string, { ms: number; price: number }>();

  constructor(cfg: FeedWatchdogConfig = {}) {
    this.maxStaleMs = cfg.maxStaleMs ?? 3 * 60_000;
    this.maxGapFrac = cfg.maxGapFrac ?? 0.1;
    this.maxDivergenceFrac = cfg.maxDivergenceFrac ?? 0.02;
  }

  /** Assess one symbol's fresh tick; updates the per-symbol memory; returns its feed health. */
  check(symbol: string, tick: FeedTick): FeedHealth {
    const prev = this.last.get(symbol);
    const stale = prev ? tick.nowMs - prev.ms > this.maxStaleMs : false;
    const gap = prev && prev.price > 0 && tick.price > 0 ? Math.abs(tick.price / prev.price - 1) > this.maxGapFrac : false;
    const divergence =
      tick.crossVenuePrice !== undefined && tick.crossVenuePrice > 0 && tick.price > 0
        ? Math.abs(tick.price / tick.crossVenuePrice - 1) > this.maxDivergenceFrac
        : false;
    // Only record a SANE price as the new baseline — a gap/divergent print must not reset the
    // baseline (else the next tick looks fine and the bad mark is silently accepted).
    if (tick.price > 0 && !gap && !divergence) this.last.set(symbol, { ms: tick.nowMs, price: tick.price });
    else if (!prev && tick.price > 0) this.last.set(symbol, { ms: tick.nowMs, price: tick.price }); // seed
    const feedStale = stale || gap || divergence;
    const parts: string[] = [];
    if (stale) parts.push(`stale ${(((tick.nowMs - (prev?.ms ?? tick.nowMs)) / 1000) | 0)}s`);
    if (gap) parts.push(`gap ${(Math.abs(tick.price / (prev!.price) - 1) * 100).toFixed(1)}%`);
    if (divergence) parts.push(`divergence ${(Math.abs(tick.price / tick.crossVenuePrice! - 1) * 100).toFixed(1)}%`);
    return { stale, gap, divergence, feedStale, detail: parts.join(', ') || 'ok' };
  }
}

// ── Alert sink (swap seam: no-op default, webhook when configured) ──────────────

export type AlertSeverity = 'info' | 'warn' | 'critical';
export interface Alert {
  readonly kind: 'stop-hit' | 'desk-halt' | 'feed-stale' | 'dd-breach';
  readonly severity: AlertSeverity;
  readonly symbol?: string;
  readonly message: string;
  readonly ts: number;
}

export interface IAlertSink {
  fire(alert: Alert): void;
}

/** The safe default: drops every alert. A desk with no channel configured behaves as before. */
export class NoopAlertSink implements IAlertSink {
  fire(_alert: Alert): void {
    /* no-op */
  }
}

export type AlertHttpPost = (url: string, body: unknown) => Promise<unknown>;

/** Posts each alert to a webhook (Slack-style {text}). Injected POST ⇒ offline-testable. Guarded. */
export class WebhookAlertSink implements IAlertSink {
  constructor(
    private readonly url: string,
    private readonly post: AlertHttpPost = async (u, b) => { await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); },
  ) {}
  fire(alert: Alert): void {
    const text = `[meridian/regime ${alert.severity.toUpperCase()}] ${alert.kind}${alert.symbol ? ` ${alert.symbol}` : ''}: ${alert.message}`;
    void Promise.resolve(this.post(this.url, { text, alert })).catch(() => { /* alerting must never break the desk */ });
  }
}

/**
 * Fans the desk's trigger conditions out to a sink, firing EXACTLY ONCE per condition:
 *   • desk-halt   — once ever (the kill-switch latches).
 *   • dd-breach   — once ever (the budget is breached once).
 *   • feed-stale  — once per false→true transition per symbol (re-arms when the feed recovers).
 *   • stop-hit    — once per call (each loss-stop is a distinct event).
 * Each method returns whether it FIRED (suppressed duplicates return false). Reuses the desk's
 * existing trigger points — it invents no new state beyond the dedup memory.
 */
export class AlertDispatcher {
  private haltFired = false;
  private ddBreachFired = false;
  private readonly staleActive = new Set<string>();

  constructor(private readonly sink: IAlertSink = new NoopAlertSink()) {}

  deskHalt(reason: string, ts = Date.now()): boolean {
    if (this.haltFired) return false;
    this.haltFired = true;
    this.sink.fire({ kind: 'desk-halt', severity: 'critical', message: reason, ts });
    return true;
  }

  drawdownBreach(drawdownFrac: number, budgetFrac: number, ts = Date.now()): boolean {
    if (this.ddBreachFired) return false;
    this.ddBreachFired = true;
    this.sink.fire({ kind: 'dd-breach', severity: 'critical', message: `desk maxDD ${(drawdownFrac * 100).toFixed(2)}% > ${(budgetFrac * 100).toFixed(2)}% budget`, ts });
    return true;
  }

  lossStop(symbol: string, detail = '', ts = Date.now()): boolean {
    this.sink.fire({ kind: 'stop-hit', severity: 'warn', symbol, message: `directional stop fired${detail ? ` (${detail})` : ''}`, ts });
    return true;
  }

  /** Drive from the watchdog each poll; fires only on the transition INTO stale (and re-arms on exit). */
  feedStale(symbol: string, stale: boolean, detail = '', ts = Date.now()): boolean {
    const was = this.staleActive.has(symbol);
    if (stale && !was) {
      this.staleActive.add(symbol);
      this.sink.fire({ kind: 'feed-stale', severity: 'warn', symbol, message: `feed unhealthy: ${detail || 'stale'}`, ts });
      return true;
    }
    if (!stale && was) this.staleActive.delete(symbol); // re-arm
    return false;
  }
}

/** Build the sink from env-style config: a webhook URL ⇒ WebhookAlertSink, else the no-op default. */
export function buildAlertSink(webhookUrl?: string, post?: AlertHttpPost): IAlertSink {
  return webhookUrl && webhookUrl.trim() ? new WebhookAlertSink(webhookUrl.trim(), post) : new NoopAlertSink();
}
