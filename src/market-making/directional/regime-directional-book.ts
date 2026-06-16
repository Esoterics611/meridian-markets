import { InventoryBook, InventoryBookState } from '../inventory/inventory-book';
import { BiasReading, effectiveBias } from '../bias/bias-source.interface';
import { biasMagnitudeCap } from '../bias/oos/forward-return-ic';
import { DeskEventInput, FillSide, classifyFill, controlEvent, fillEvent } from '../events/desk-event';

// RegimeDirectionalBook — the standalone "take sides" book (REGIME_DIRECTIONAL_BOOK.md).
// Unlike the axed market-maker (which expresses a view by SKEWING quotes), this book
// takes an OUTRIGHT, sized, stopped position when a VALIDATED regime view is strong,
// and sits FLAT otherwise. It is the consumer that turns the desk's already-built
// directional signal (IBiasSource + the OOS forward-return gate) into a position.
//
// "Not a bot, managed in our engine": it reuses the same accounting (InventoryBook),
// the same honesty gate (effectiveBias — an unvalidated reading sizes ZERO), and the
// same event tape (DeskEvent) as the rest of the desk, so every entry/exit/stop is
// auditable and realised-first. Conservative by construction:
//   • conviction sizing  — position scales with |bias| (and the OOS IC cap);
//   • directional stop    — a max adverse excursion flattens a wrong view (preempts all);
//   • decay-to-flat       — a faded/flipped/unvalidated view is exited, never ridden;
//   • stand-aside         — a regime-change flag (basis blowout / vol spike) flattens.
//
// Pure + clock-free (the caller passes nowMs + the tick), exactly like FlowRegimeMachine,
// so it is fully unit-testable and replayable offline. The live loop (P4) feeds it real
// ticks and routes the fills through PaperVenue; here it books fills against its own
// InventoryBook at the provided mid + a taker fee.

const MICROS = 1_000_000n;
const MS_PER_HOUR = 3_600_000;

export type RegimeBookTrigger = 'entry' | 'flip' | 'decay' | 'stand-aside' | 'loss-stop' | 'hold' | 'flat';

export interface RegimeDirectionalConfig {
  /** Position notional (USD) at full conviction (|bias| = 1). Scales linearly with conviction. */
  readonly baseNotionalUsd: number;
  /** Entry conviction floor: open only when |effectiveBias| ≥ this. Default 0.15. */
  readonly bEnter?: number;
  /** Exit hysteresis: a held position decays to flat when |effectiveBias| < this. Default 0.07. */
  readonly bExit?: number;
  /** Directional stop: flatten when unrealised P&L < −stopFrac × |position notional|. Default 0.02. */
  readonly stopFrac?: number;
  /** Outright taker fee (bps) charged on every entry/exit leg. Default 4.5. */
  readonly takerFeeBps?: number;
  /** Hard cap on |position notional| (USD), regardless of conviction. Default = baseNotionalUsd. */
  readonly maxNotionalUsd?: number;
  /** biasMagnitudeCap k: conviction = min(|bias|, k·|IC|) when a tick carries `ic`. Default 4. */
  readonly icSizeK?: number;
  /** biasMagnitudeCap hard cap. Default 0.5. */
  readonly icSizeHardCap?: number;
  /** Optional tape hook — a DeskEvent on every entry/exit/stop (like FlowRegimeMachine.onTransition). */
  readonly onEvent?: (e: DeskEventInput) => void;
  /** Book/symbol label for events. Default 'REGIME'. */
  readonly book?: string;
  /** Event source label. Default 'regime-directional'. */
  readonly source?: string;
}

export interface RegimeTick {
  readonly nowMs: number;
  /** Current fair mid (price micros). */
  readonly midMicros: bigint;
  /** The (consensus) bias reading this tick. */
  readonly reading: BiasReading;
  /** Optional OOS rank-IC for conviction sizing (caps |bias| via biasMagnitudeCap). */
  readonly ic?: number;
  /** Signed perp funding rate per hour (+ ⇒ longs pay shorts). Accrues on the held position. */
  readonly fundingRatePerHour?: number;
  /** Regime monitor says stand aside (basis blowout / vol spike / stale feed) — flatten, no entry. */
  readonly standAside?: boolean;
}

export interface RegimeBookAction {
  /** How the position moved (from desk-event's classifyFill). */
  readonly action: 'none' | 'open' | 'add' | 'reduce' | 'close' | 'flip';
  /** Why it moved — the trigger label that rides into the tape. */
  readonly trigger: RegimeBookTrigger;
  /** The position the book is steering toward this tick (signed asset units). */
  readonly targetUnits: bigint;
  /** Signed units actually traded this tick (0 if no change). */
  readonly filledUnits: bigint;
  readonly reason: string;
}

/**
 * The full durable state of a RegimeDirectionalBook (P6 restart-safe books). The book
 * is exactly reconstructable from this — config (sizing/stop/fees) is rebuilt fresh on boot
 * from the gate, only the EVOLVING ledger + accumulators are persisted. bigints are decimal
 * STRINGS so the blob survives JSON + a Postgres JSONB round-trip.
 */
export interface RegimeBookState {
  /** The InventoryBook ledger (inventory, avg-cost, realised, fees, fill count). */
  readonly book: InventoryBookState;
  /** Accrued funding P&L, USDC-units. */
  readonly fundingAccruedUnits: string;
  /** The last-seen tick clock — REQUIRED so funding accrues over the right Δt after a restart
   *  (the regime analogue of the #47 rehydrate trap: drop this and a revived book mis-accrues). */
  readonly lastMs: number | null;
}

export interface RegimeBookSnapshot {
  readonly inventoryUnits: bigint;
  readonly realisedUnits: bigint;
  readonly feesUnits: bigint;
  readonly fundingUnits: bigint;
  readonly unrealisedUnits: bigint;
  /** realised − fees + funding + unrealised. */
  readonly totalPnlUnits: bigint;
  readonly fills: number;
}

function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function bigSign(x: bigint): -1 | 0 | 1 {
  return x > 0n ? 1 : x < 0n ? -1 : 0;
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export class RegimeDirectionalBook {
  private readonly inv = new InventoryBook();
  private fundingAccrued = 0n;
  private lastMs: number | null = null;

  private readonly baseNotionalUsd: number;
  private readonly bEnter: number;
  private readonly bExit: number;
  private readonly stopFrac: number;
  private readonly takerFeeBps: number;
  private readonly maxNotionalUsd: number;
  private readonly icSizeK: number;
  private readonly icSizeHardCap: number;
  private readonly onEvent?: (e: DeskEventInput) => void;
  private readonly book: string;
  private readonly source: string;

  constructor(cfg: RegimeDirectionalConfig) {
    this.baseNotionalUsd = cfg.baseNotionalUsd;
    this.bEnter = cfg.bEnter ?? 0.15;
    this.bExit = cfg.bExit ?? 0.07;
    this.stopFrac = cfg.stopFrac ?? 0.02;
    this.takerFeeBps = cfg.takerFeeBps ?? 4.5;
    this.maxNotionalUsd = cfg.maxNotionalUsd ?? cfg.baseNotionalUsd;
    this.icSizeK = cfg.icSizeK ?? 4;
    this.icSizeHardCap = cfg.icSizeHardCap ?? 0.5;
    this.onEvent = cfg.onEvent;
    this.book = cfg.book ?? 'REGIME';
    this.source = cfg.source ?? 'regime-directional';
    if (this.bExit >= this.bEnter) {
      throw new Error('RegimeDirectionalBook: bExit must be < bEnter (hysteresis band)');
    }
  }

  /** Feed one tick; the book decides its target position, trades the delta, and reports. */
  update(tick: RegimeTick): RegimeBookAction {
    // Funding accrues on whatever position was HELD over the interval since the last tick.
    this.accrueFunding(tick);
    this.lastMs = tick.nowMs;

    const inv0 = this.inv.inventoryUnits();
    const effB = effectiveBias(tick.reading); // 0 unless the reading is validated — THE gate.

    // 1. Directional stop preempts everything (STEP −1 coherence: the stop fires before any
    //    signal-driven decay, so a blown view is cut by the stop, not coincidentally by decay).
    if (inv0 !== 0n && this.stopBreached(tick.midMicros)) {
      const a = this.moveTo(0n, tick, 'loss-stop', `stop: unrealised < −${(this.stopFrac * 100).toFixed(2)}% notional`);
      this.emitControl(tick, `loss-stop fired → flattened (${a.reason})`);
      return a;
    }
    // 2. Regime stand-aside — no new entry; flatten an open position.
    if (tick.standAside) {
      if (inv0 === 0n) return this.noop(0n, 'flat', 'stand-aside: flat');
      return this.moveTo(0n, tick, 'stand-aside', 'regime stand-aside → flatten');
    }

    // 3. Signal → target position.
    const target = this.targetUnits(inv0, effB, tick);
    if (target === inv0) {
      return this.noop(target, inv0 === 0n ? 'flat' : 'hold', this.holdReason(inv0, effB, tick.reading));
    }
    const trigger: RegimeBookTrigger =
      inv0 === 0n ? 'entry' : target === 0n ? 'decay' : bigSign(target) !== bigSign(inv0) ? 'flip' : 'entry';
    return this.moveTo(target, tick, trigger, tick.reading.reason);
  }

  // ── position sizing ────────────────────────────────────────────────────────────

  /** The target position for the current inventory + view. 0 = flat. */
  private targetUnits(inv0: bigint, effB: number, tick: RegimeTick): bigint {
    const absB = Math.abs(effB);
    const sB = sign(effB);
    const sInv = bigSign(inv0);

    if (inv0 === 0n) {
      // Flat: enter only on a strong, validated view.
      return absB >= this.bEnter ? this.sizedUnits(sB, absB, tick) : 0n;
    }
    // Holding a position.
    if (sB === 0 || absB < this.bExit) return 0n; // view gone / faded below the exit band ⇒ flat.
    if (sB !== sInv) {
      // View now opposes the held side: flip if strong, else exit to flat (never ride an opposed view).
      return absB >= this.bEnter ? this.sizedUnits(sB, absB, tick) : 0n;
    }
    // View agrees with the held side and is ≥ bExit ⇒ HOLD the existing size (no resize churn).
    return inv0;
  }

  /** Conviction-scaled signed position size in asset units at the tick's mid. */
  private sizedUnits(s: number, absB: number, tick: RegimeTick): bigint {
    // Conviction is |bias|, capped by the OOS IC when one is supplied (a strong signal on
    // one noisy window must not rest the book at full size).
    const cap = tick.ic === undefined ? 1 : biasMagnitudeCap(tick.ic, this.icSizeK, this.icSizeHardCap);
    const conviction = Math.min(absB, cap);
    const notionalUsd = Math.min(this.baseNotionalUsd * conviction, this.maxNotionalUsd);
    const notionalUnits = BigInt(Math.round(notionalUsd * 1_000_000));
    const units = (notionalUnits * MICROS) / tick.midMicros;
    return BigInt(s) * units;
  }

  // ── risk ───────────────────────────────────────────────────────────────────────

  /** True when the open position's mark-to-market loss exceeds the directional stop band. */
  private stopBreached(midMicros: bigint): boolean {
    const inv = this.inv.inventoryUnits();
    if (inv === 0n) return false;
    const unreal = this.inv.unrealisedUnits(midMicros);
    if (unreal >= 0n) return false;
    const notionalUnits = (bigAbs(inv) * midMicros) / MICROS;
    const stopUnits = BigInt(Math.round(Number(notionalUnits) * this.stopFrac));
    return -unreal > stopUnits;
  }

  // ── funding ──────────────────────────────────────────────────────────────────

  /** Accrue signed funding on the position held since the previous tick. */
  private accrueFunding(tick: RegimeTick): void {
    const inv = this.inv.inventoryUnits();
    if (this.lastMs === null || inv === 0n || tick.fundingRatePerHour === undefined) return;
    const hours = Math.max(0, (tick.nowMs - this.lastMs) / MS_PER_HOUR);
    if (hours === 0) return;
    const notionalUnits = (bigAbs(inv) * tick.midMicros) / MICROS;
    // + funding ⇒ longs pay shorts: a long position LOSES rate·notional/hr, a short GAINS it.
    const fundingPnl = -bigSign(inv) * tick.fundingRatePerHour * hours * Number(notionalUnits);
    this.fundingAccrued += BigInt(Math.round(fundingPnl));
  }

  // ── execution + tape ───────────────────────────────────────────────────────────

  /** Trade the delta to reach `target`, book it, emit the fill event, and report. */
  private moveTo(target: bigint, tick: RegimeTick, trigger: RegimeBookTrigger, reason: string): RegimeBookAction {
    const inv0 = this.inv.inventoryUnits();
    const delta = target - inv0;
    if (delta === 0n) return this.noop(target, inv0 === 0n ? 'flat' : 'hold', reason);

    const side: FillSide = delta > 0n ? 'BUY' : 'SELL';
    const sizeUnits = bigAbs(delta);
    const tradeValueUnits = (sizeUnits * tick.midMicros) / MICROS;
    const feeUnits = BigInt(Math.round((Number(tradeValueUnits) * this.takerFeeBps) / 10_000));

    const realisedBefore = this.inv.realisedUnits();
    this.inv.apply({ side, sizeUnits, priceMicros: tick.midMicros, feeUnits });
    const realisedDelta = this.inv.realisedUnits() - realisedBefore;
    const after = this.inv.inventoryUnits();
    const action = classifyFill(inv0, after);

    if (this.onEvent) {
      try {
        const ev = fillEvent({
          ts: tick.nowMs,
          book: this.book,
          source: this.source,
          side,
          action,
          sizeUnits,
          priceMicros: tick.midMicros,
          inventoryUnits: after,
          realisedDeltaUnits: realisedDelta,
          feeUnits,
          trigger,
        });
        this.onEvent(ev);
      } catch {
        /* observability must never break the book */
      }
    }
    return { action, trigger, targetUnits: target, filledUnits: delta, reason };
  }

  private emitControl(tick: RegimeTick, detail: string): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(controlEvent({ ts: tick.nowMs, book: this.book, detail }));
    } catch {
      /* never break the book */
    }
  }

  private noop(target: bigint, trigger: RegimeBookTrigger, reason: string): RegimeBookAction {
    return { action: 'none', trigger, targetUnits: target, filledUnits: 0n, reason };
  }

  private holdReason(inv0: bigint, effB: number, reading: BiasReading): string {
    if (inv0 === 0n) return `flat: ${reading.reason}`;
    return `hold ${inv0 > 0n ? 'long' : 'short'} (|b|=${Math.abs(effB).toFixed(3)} in band): ${reading.reason}`;
  }

  // ── reporting ────────────────────────────────────────────────────────────────

  inventoryUnits(): bigint {
    return this.inv.inventoryUnits();
  }

  realisedUnits(): bigint {
    return this.inv.realisedUnits();
  }

  feesUnits(): bigint {
    return this.inv.feesUnits();
  }

  fundingUnits(): bigint {
    return this.fundingAccrued;
  }

  unrealisedUnits(midMicros: bigint): bigint {
    return this.inv.unrealisedUnits(midMicros);
  }

  /** Total P&L: realised − fees + funding + unrealised(mark). */
  totalPnlUnits(midMicros: bigint): bigint {
    return this.inv.totalPnlUnits(midMicros) + this.fundingAccrued;
  }

  snapshot(midMicros: bigint): RegimeBookSnapshot {
    return {
      inventoryUnits: this.inv.inventoryUnits(),
      realisedUnits: this.inv.realisedUnits(),
      feesUnits: this.inv.feesUnits(),
      fundingUnits: this.fundingAccrued,
      unrealisedUnits: this.inv.unrealisedUnits(midMicros),
      totalPnlUnits: this.totalPnlUnits(midMicros),
      fills: this.inv.fills(),
    };
  }

  // ── persistence (P6 — restart-safe books) ──────────────────────────────────────

  /** Snapshot the full evolving state for durable persistence. */
  serializeState(): RegimeBookState {
    return {
      book: this.inv.serialize(),
      fundingAccruedUnits: this.fundingAccrued.toString(),
      lastMs: this.lastMs,
    };
  }

  /** Restore a previously-serialised state (overwrites the ledger, funding, and tick clock). */
  restoreState(s: RegimeBookState): void {
    this.inv.restore(s.book);
    this.fundingAccrued = BigInt(s.fundingAccruedUnits);
    this.lastMs = s.lastMs;
  }
}
