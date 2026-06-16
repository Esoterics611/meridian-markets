// RegimeDeskRisk — the DESK-LEVEL risk layer for the "take sides" desk (Playbook II P5).
// One bad book must not be able to sink the desk, and the terminal runner lacked the
// "react" controls a trader needs. Each poll the runner hands this object every book's
// {notionalUsd, side, realisedPnl, unrealisedPnl}; it enforces, in this order:
//   (a) GROSS + NET exposure caps (USD)   — cap how much the desk can GROW (BlockNewEntry)
//   (b) DAILY-LOSS LIMIT                    — realised+funding−fees below −X ⇒ HALT the desk
//   (c) DESK maxDD CIRCUIT BREAKER          — peak-to-trough equity beyond Y% of capital ⇒ HALT
// plus the manual kill controls: manualHalt() (a latching kill-switch) and
// manualFlatten(symbol). It returns a verdict per book (Allow / BlockNewEntry / FlattenNow)
// and a desk verdict (Run / Halt).
//
// The breakers LATCH: a tripped daily-loss / maxDD / manual halt stays tripped until reset()
// (a new session). A kill-switch you can accidentally un-trip — because a flatten temporarily
// recovered the drawdown — is not a kill-switch. The exposure caps do NOT latch; they BlockNewEntry
// only while the desk is over the cap, so the desk can grow again once books have shed exposure.
//
// Stateful-but-deterministic (it tracks the peak desk equity for the drawdown breaker),
// clock-free, no I/O — exactly like RegimeMonitor / FlowRegimeMachine, so it is fully
// replayable and unit-testable at the boundaries. It mirrors CompositeRiskGate's verdict
// shape (Allow/Deny/Pause → Allow/BlockNewEntry/FlattenNow) so the desk reads consistently.

export type DeskRiskComponent =
  | 'gross-cap'
  | 'net-cap'
  | 'daily-loss'
  | 'desk-maxdd'
  | 'manual-halt'
  | 'manual-flatten';

/** Per-book verdict, in escalating severity. */
export type BookVerdict =
  | { kind: 'Allow' }
  | { kind: 'BlockNewEntry'; reason: string; component: DeskRiskComponent }
  | { kind: 'FlattenNow'; reason: string; component: DeskRiskComponent };

/** Desk-wide verdict. Halt ⇒ every book is FlattenNow. */
export type DeskVerdict =
  | { kind: 'Run' }
  | { kind: 'Halt'; reason: string; component: DeskRiskComponent };

export interface RegimeDeskRiskConfig {
  /** Gross exposure cap: Σ|notional| at/above this blocks new entries. USD. */
  readonly maxGrossUsd: number;
  /** Net exposure cap: |Σ signed notional| at/above this blocks new entries. USD. */
  readonly maxNetUsd: number;
  /** Daily realised-loss limit: realised+funding−fees below −this HALTs the desk. USD. */
  readonly dailyLossLimitUsd: number;
  /** Desk capital, USD — the denominator for the maxDD breaker. */
  readonly capitalUsd: number;
  /** Desk maxDD breaker: peak-to-trough equity beyond this fraction of capital HALTs. e.g. 0.02 = 2%. */
  readonly maxDrawdownFrac: number;
}

export interface BookRiskInput {
  readonly symbol: string;
  /** |position notional|, USD ≥ 0. */
  readonly notionalUsd: number;
  readonly side: 'LONG' | 'SHORT' | 'FLAT';
  /** Realised P&L for this book: realised − fees + funding, USD. */
  readonly realisedPnlUsd: number;
  /** Mark-to-market unrealised P&L, USD. */
  readonly unrealisedPnlUsd: number;
}

export interface DeskRiskAssessment {
  readonly desk: DeskVerdict;
  readonly perBook: Map<string, BookVerdict>;
  readonly grossUsd: number;
  readonly netUsd: number;
  /** Σ realised P&L (realised − fees + funding) across books. */
  readonly realisedUsd: number;
  /** Σ (realised + unrealised) across books — the equity the maxDD breaker watches. */
  readonly equityUsd: number;
  readonly peakEquityUsd: number;
  readonly drawdownUsd: number;
  readonly drawdownFrac: number;
}

const ALLOW: BookVerdict = { kind: 'Allow' };

export class RegimeDeskRisk {
  /** Peak desk equity (P&L) seen this session — starts at 0 (flat = the high-water mark at open). */
  private peakEquityUsd = 0;
  /** A latched halt, once tripped, survives until reset(). */
  private latchedHalt: { reason: string; component: DeskRiskComponent } | null = null;
  private readonly flattenSet = new Set<string>();

  constructor(private readonly cfg: RegimeDeskRiskConfig) {
    if (cfg.maxGrossUsd <= 0 || cfg.maxNetUsd <= 0) {
      throw new Error('RegimeDeskRisk: maxGrossUsd / maxNetUsd must be > 0');
    }
    if (cfg.maxDrawdownFrac <= 0) {
      throw new Error('RegimeDeskRisk: maxDrawdownFrac must be > 0');
    }
    if (cfg.dailyLossLimitUsd <= 0) {
      throw new Error('RegimeDeskRisk: dailyLossLimitUsd must be > 0');
    }
  }

  /** Latch a manual desk halt (kill switch). Idempotent — the first reason sticks. */
  manualHalt(reason = 'manual kill switch'): void {
    if (!this.latchedHalt) this.latchedHalt = { reason, component: 'manual-halt' };
  }
  /** Queue a one-symbol flatten; cleared by clearFlatten or reset. */
  manualFlatten(symbol: string): void {
    this.flattenSet.add(symbol.toUpperCase());
  }
  clearFlatten(symbol: string): void {
    this.flattenSet.delete(symbol.toUpperCase());
  }
  isHalted(): boolean {
    return this.latchedHalt !== null;
  }
  haltReason(): string | null {
    return this.latchedHalt?.reason ?? null;
  }
  /** New session: drop the peak, un-latch, clear pending flattens. */
  reset(): void {
    this.peakEquityUsd = 0;
    this.latchedHalt = null;
    this.flattenSet.clear();
  }

  /** Assess the desk from the current per-book state. Latches a breach; returns verdicts. */
  assess(books: readonly BookRiskInput[]): DeskRiskAssessment {
    let grossUsd = 0;
    let netUsd = 0;
    let realisedUsd = 0;
    let unrealisedUsd = 0;
    for (const b of books) {
      const n = Math.abs(b.notionalUsd);
      grossUsd += n;
      netUsd += b.side === 'LONG' ? n : b.side === 'SHORT' ? -n : 0;
      realisedUsd += b.realisedPnlUsd;
      unrealisedUsd += b.unrealisedPnlUsd;
    }
    const equityUsd = realisedUsd + unrealisedUsd;
    if (equityUsd > this.peakEquityUsd) this.peakEquityUsd = equityUsd;
    const drawdownUsd = this.peakEquityUsd - equityUsd;
    const drawdownFrac = this.cfg.capitalUsd > 0 ? drawdownUsd / this.cfg.capitalUsd : 0;

    // ── desk verdict (latching circuit breakers) ───────────────────────────────
    if (!this.latchedHalt) {
      if (realisedUsd < -this.cfg.dailyLossLimitUsd) {
        this.latchedHalt = {
          reason: `daily realised loss $${realisedUsd.toFixed(0)} < −$${this.cfg.dailyLossLimitUsd}`,
          component: 'daily-loss',
        };
      } else if (drawdownFrac > this.cfg.maxDrawdownFrac) {
        this.latchedHalt = {
          reason: `desk maxDD ${(drawdownFrac * 100).toFixed(2)}% > ${(this.cfg.maxDrawdownFrac * 100).toFixed(2)}% budget`,
          component: 'desk-maxdd',
        };
      }
    }
    const desk: DeskVerdict = this.latchedHalt ? { kind: 'Halt', ...this.latchedHalt } : { kind: 'Run' };

    // ── per-book verdicts ──────────────────────────────────────────────────────
    const overGross = grossUsd >= this.cfg.maxGrossUsd;
    const overNet = Math.abs(netUsd) >= this.cfg.maxNetUsd;
    const perBook = new Map<string, BookVerdict>();
    for (const b of books) {
      const sym = b.symbol;
      // 1. A halted desk flattens every book.
      if (this.latchedHalt) {
        perBook.set(sym, { kind: 'FlattenNow', reason: this.latchedHalt.reason, component: this.latchedHalt.component });
        continue;
      }
      // 2. A manually-queued flatten for this symbol.
      if (this.flattenSet.has(sym.toUpperCase())) {
        perBook.set(sym, { kind: 'FlattenNow', reason: 'manual flatten', component: 'manual-flatten' });
        continue;
      }
      // 3. Over an exposure cap ⇒ block new entries (hold the open ones; the desk just can't grow).
      if (overGross) {
        perBook.set(sym, {
          kind: 'BlockNewEntry',
          reason: `gross $${grossUsd.toFixed(0)} ≥ cap $${this.cfg.maxGrossUsd}`,
          component: 'gross-cap',
        });
        continue;
      }
      if (overNet) {
        perBook.set(sym, {
          kind: 'BlockNewEntry',
          reason: `net $${netUsd.toFixed(0)} ≥ cap $${this.cfg.maxNetUsd}`,
          component: 'net-cap',
        });
        continue;
      }
      perBook.set(sym, ALLOW);
    }

    return {
      desk,
      perBook,
      grossUsd,
      netUsd,
      realisedUsd,
      equityUsd,
      peakEquityUsd: this.peakEquityUsd,
      drawdownUsd,
      drawdownFrac,
    };
  }
}
