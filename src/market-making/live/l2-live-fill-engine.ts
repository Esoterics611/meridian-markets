import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair } from '../quote/quote-pair';
import { RollingVolatility } from '../quote/volatility';
import { InventoryBook, FillSide } from '../inventory/inventory-book';
import { attributeFill, PnlComponent, sumComponents, AttributionSummary } from '../backtest/pnl-attribution';
import { RiskGate, RiskState } from '../risk/risk-gate';
import { OrderBook, midMicros } from '../microstructure/order-book';
import { microPriceMicrosFromL2 } from '../microstructure/l2-microprice';
import { l2SnapshotToOrderBook } from '../backtest/l2-tape';
import { RestingQuote, IntervalFlow, settleRestingOrder, placeRestingOrder } from '../backtest/queue-fill';
import { LiveTick } from './l2-fill-engine-types';

// L2LiveFillEngine — the LIVE, queue-aware, fast-cadence MM fill engine. It is the
// LobReplayHarness's logic (FIFO queue position, micro-price center, markout adverse
// selection, maker-fee P&L) driven by LIVE L2 snapshots arriving on a sub-second
// cadence instead of a pre-recorded tape (FAIR_VALUE_AND_THESIS_DESIGN.md §6b — the
// fast-requote lever that flipped spread-vs-adverse −$1,020 → +$133 in offline replay;
// this brings that path to the live loop). The single-side FIFO fill DECISION is the
// SHARED pure function `settleRestingOrder` (backtest/queue-fill.ts), extracted from
// the harness so the live and replay paths cannot drift; placement is the shared
// `placeRestingOrder`. The accounting is the EXISTING InventoryBook + PnlAttributor —
// no parallel P&L path (CLAUDE.md). What this adds over the harness:
//
//   - It is fed one live snapshot at a time via `onSnapshot(snap)` (the poll driver
//     calls this), holding resting quotes across calls — so it works on a stream,
//     not an array.
//   - The adverse-selection markout is taken at the RE-QUOTE horizon (the fast
//     cadence between snapshots), not one 15s bar — the whole point of §6b: a book
//     re-quoting every few hundred ms carries far less stale-quote risk, so the true
//     adverse is much smaller than the coarse-bar sim shows.
//   - A realistic **cancel/replace latency** rail: a re-priced quote is not LIVE in
//     the book until `cancelReplaceLatencyMs` after the re-quote (network + matching-
//     engine round-trip). A snapshot whose flow would have filled the *new* order
//     within that window does NOT fill it — without this the fast-requote benefit is
//     a free-lunch fantasy (§6b honesty rail). Held quotes (same price) stay live.
//   - The maker fee is the venue's REAL signed maker bps (venue-fees.ts → makerFeeBps),
//     so a −0.2bps HL rebate is revenue and a +1bps cost is earned back on both legs.
//
// Aggressive flow per interval is NOT in the depth feed; the caller supplies it
// (real HL trades-WS prints when available, else the candle-volume estimate — the
// same source the capture scripts use). When omitted, a snapshot still re-quotes +
// decays the queue but books no fills (depth-only ticks), exactly as a tape step with
// zero flow would. Float-free for cash at the boundary; quote-time σ/γ math is float
// inside the quoter, rounded to bigint micros before any fill is scored.

const MICROS = 1_000_000n;

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

/** A resting order plus the live-loop bookkeeping the engine needs (latency + fair value). */
interface LiveResting extends RestingQuote {
  /** Epoch ms from which this order is actually LIVE in the book (cancel/replace latency). */
  liveFromMs: number;
  /** Mid at the most recent (re)quote — the fair value the next fill's spread is scored against. */
  fairMidMicros: bigint;
  /** Snapshot ms at the most recent (re)quote — markout horizon start for adverse selection. */
  quotedAtMs: number;
}

export interface L2LiveFillEngineConfig {
  symbol: string;
  quoter: IQuoter;
  /** Asset units quoted per side (6-dec). */
  quoteSizeUnits: bigint;
  gamma: number;
  kappa: number;
  horizonBars: number;
  volWindowBars: number;
  volFloor: number;
  /** Maker fee in bps, SIGNED: negative = rebate (revenue). From venueFeeFor(source).makerBps. */
  makerFeeBps: number;
  capitalUnits: bigint;
  /**
   * Quote around the book-imbalance MICRO-PRICE over this many levels per side (F1 —
   * the live fair-value center). Attribution + drawdown stay scored against the PLAIN
   * mid (the true fair value), so this honestly measures whether the micro-price
   * center REDUCES adverse selection. 0/undefined ⇒ quote off the mid (legacy).
   */
  microDepth?: number;
  /**
   * Cancel/replace latency in ms (network + matching-engine round-trip). A re-priced
   * quote is not live in the book until this long after the re-quote, so a snapshot
   * arriving inside the window cannot fill the new order — the §6b honesty rail that
   * keeps fast re-quoting from being a free lunch. Default 100ms (a fair HL/CLOB
   * round-trip without colocation). 0 ⇒ zero-latency fantasy (tests can set it to
   * isolate the queue mechanics; production must keep it realistic).
   */
  cancelReplaceLatencyMs?: number;
  riskGate?: RiskGate;
}

export interface L2LiveFillEngineMetrics {
  snapshots: number;
  quotingSteps: number;
  /** Honest, queue-aware fills (the real number). */
  queueFills: number;
  /** Fills a fill-on-touch model would have logged — the upper bound. */
  touchFills: number;
  /** Fills BLOCKED purely by the cancel/replace latency rail (would have filled, didn't). */
  latencyBlockedFills: number;
  fillRatio: number;
  bidFills: number;
  askFills: number;
  realisedPnlUnits: bigint;
  finalInventoryUnits: bigint;
  unrealisedPnlUnits: bigint;
  netPnlUnits: bigint;
  feesUnits: bigint;
  maxDrawdownPct: number;
  attribution: AttributionSummary;
}

export class L2LiveFillEngine {
  private readonly cfg: L2LiveFillEngineConfig;
  private readonly vol: RollingVolatility;
  private readonly book = new InventoryBook();
  private readonly components: PnlComponent[] = [];
  private readonly latencyMs: number;

  private restingBid: LiveResting | undefined;
  private restingAsk: LiveResting | undefined;
  private snapshots = 0;
  private quotingSteps = 0;
  private queueFills = 0;
  private touchFills = 0;
  private latencyBlockedFills = 0;
  private bidFills = 0;
  private askFills = 0;
  private peakEquity: bigint;
  private maxDrawdownPct = 0;
  private lastMidMicros: bigint | undefined;

  constructor(cfg: L2LiveFillEngineConfig) {
    this.cfg = cfg;
    this.vol = new RollingVolatility(cfg.volWindowBars);
    this.latencyMs = Math.max(0, cfg.cancelReplaceLatencyMs ?? 100);
    this.peakEquity = cfg.capitalUnits;
  }

  /** Seed the σ window from recent mids/closes so the engine can quote on its first live tick. */
  warmup(closes: number[]): void {
    for (const c of closes) this.vol.push(c);
  }

  /**
   * Feed ONE live snapshot (+ optional interval flow). Settles resting orders against
   * the flow, then re-quotes off this book. Pure + deterministic given the snapshot
   * stream — the engine holds the resting quotes and queue state across calls. Returns
   * the quote now resting (for telemetry/UI), or null while warming / on an empty book.
   */
  onSnapshot(tick: LiveTick): QuotePair | null {
    const snap = tick.snapshot;
    const ob: OrderBook = l2SnapshotToOrderBook(snap);
    const mid = midMicros(ob);
    if (mid === undefined) return null; // empty book — nothing to mark or quote against
    const nowMs = snap.ts.getTime();
    this.snapshots += 1;
    this.vol.push(Number(mid) / 1e6);
    this.lastMidMicros = mid;

    const flow: IntervalFlow = {
      aggressiveBuyUnits: tick.flow?.aggressiveBuyUnits ?? 0n,
      aggressiveSellUnits: tick.flow?.aggressiveSellUnits ?? 0n,
      tradedHighMicros: tick.flow?.tradedHighMicros,
      tradedLowMicros: tick.flow?.tradedLowMicros,
    };

    // --- 1) settle orders resting since the previous snapshot against THIS flow ---
    this.restingBid = this.settle(this.restingBid, ob, flow, nowMs, mid);
    this.restingAsk = this.settle(this.restingAsk, ob, flow, nowMs, mid);

    if (!this.vol.ready()) {
      this.markDd(mid);
      return null; // warmup: don't quote yet
    }

    // --- 2) re-quote off this book ---
    const inventoryBefore = this.book.inventoryUnits();
    // F1: center the quote on the book-imbalance micro-price when enabled, else the mid.
    // Attribution below still scores against the plain `mid` (the true fair value).
    let referenceMicros: bigint | undefined;
    if (this.cfg.microDepth && this.cfg.microDepth > 0) {
      const mp = microPriceMicrosFromL2(snap, this.cfg.microDepth);
      if (mp !== null && mp > 0n) referenceMicros = mp;
    }
    const ctx: QuoteContext = {
      inventoryUnits: inventoryBefore,
      midMicros: mid,
      referenceMicros,
      volatility: this.vol.valueOr(this.cfg.volFloor),
      riskAversion: this.cfg.gamma,
      arrivalDecay: this.cfg.kappa,
      horizonBars: this.cfg.horizonBars,
      schemaVersion: 1,
    };
    const quote = this.cfg.quoter.quote(ctx, this.cfg.symbol);

    if (this.cfg.riskGate) {
      const navRatio = Number(this.book.equityUnits(this.cfg.capitalUnits, mid)) / Number(this.cfg.capitalUnits);
      const state: RiskState = { inventoryUnits: inventoryBefore, navRatio, vpin: 0, recentAdverseUnits: 0n, killed: false };
      if (this.cfg.riskGate.check(quote, state).kind !== 'Allow') {
        this.restingBid = undefined; // pull quotes on Deny/Pause
        this.restingAsk = undefined;
        this.markDd(mid);
        return quote;
      }
    }
    this.quotingSteps += 1;

    this.restingBid = this.reprice(this.restingBid, 'BUY', quote.bid.priceMicros, ob, mid, nowMs);
    this.restingAsk = this.reprice(this.restingAsk, 'SELL', quote.ask.priceMicros, ob, mid, nowMs);

    // --- 3) mark drawdown on the structural equity at this mid ---
    this.markDd(mid);
    return quote;
  }

  /** Settle one resting order against the step's flow, honouring the cancel/replace latency. */
  private settle(order: LiveResting | undefined, ob: OrderBook, flow: IntervalFlow, nowMs: number, markoutMid: bigint): LiveResting | undefined {
    if (!order) return undefined;
    const outcome = settleRestingOrder(order, ob, flow);
    if (outcome.touched) this.touchFills += 1;
    // The cancel/replace latency rail: an order is only fillable once it has been live
    // in the book for `latencyMs`. A would-be fill inside that window is BLOCKED (it
    // never reached the matching engine in time) — the §6b free-lunch guard.
    const live = nowMs >= order.liveFromMs;
    if (outcome.filledUnits > 0n && !live) {
      this.latencyBlockedFills += 1;
      // The order survives unchanged (size + queue progress) — it simply wasn't live
      // yet; carry the decayed remaining position forward without booking the fill.
      if (!outcome.remaining) return undefined;
      return { ...order, sizeUnits: outcome.remaining.sizeUnits + outcome.filledUnits, pos: outcome.remaining.pos };
    }
    if (outcome.filledUnits > 0n) {
      const side: FillSide = order.side;
      this.applyFill(side, order.priceMicros, outcome.filledUnits, order.fairMidMicros, markoutMid);
      this.queueFills += 1;
      if (side === 'BUY') this.bidFills += 1;
      else this.askFills += 1;
    }
    if (!outcome.remaining) return undefined;
    return { ...order, sizeUnits: outcome.remaining.sizeUnits, pos: outcome.remaining.pos };
  }

  /** Re-price (place/persist) one side, stamping the cancel/replace latency + fair value. */
  private reprice(current: LiveResting | undefined, side: FillSide, priceMicros: bigint, ob: OrderBook, mid: bigint, nowMs: number): LiveResting | undefined {
    const res = placeRestingOrder(current, side, priceMicros, this.cfg.quoteSizeUnits, ob);
    if (!res.order) return undefined; // post-only rejected
    const heldSamePrice = current && current.priceMicros === priceMicros;
    if (heldSamePrice && current) {
      // Held our price: keep queue progress + the SAME liveFrom (no new cancel/replace),
      // refresh the fair mid + markout start so adverse is measured from the latest quote.
      return { ...res.order, liveFromMs: current.liveFromMs, fairMidMicros: mid, quotedAtMs: nowMs };
    }
    // A fresh placement (new price or first quote): subject to the cancel/replace latency.
    return { ...res.order, liveFromMs: nowMs + this.latencyMs, fairMidMicros: mid, quotedAtMs: nowMs };
  }

  private applyFill(side: FillSide, priceMicros: bigint, qty: bigint, fairMid: bigint, markoutMid: bigint): void {
    const notional = valueUnits(qty, priceMicros);
    const fee = (notional * BigInt(Math.round(this.cfg.makerFeeBps * 100))) / 1_000_000n;
    const invBefore = this.book.inventoryUnits();
    this.book.apply({ side, sizeUnits: qty, priceMicros, feeUnits: fee });
    // Adverse selection is the markout at the RE-QUOTE horizon (this snapshot's mid vs
    // the fair mid when the order was quoted) — the fast cadence, not a coarse bar.
    this.components.push(attributeFill({ side, sizeUnits: qty, priceMicros, feeUnits: fee }, fairMid, markoutMid, invBefore));
  }

  private markDd(mid: bigint): void {
    const equity = this.book.equityUnits(this.cfg.capitalUnits, mid);
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity > 0n) {
      const dd = (Number(this.peakEquity - equity) / Number(this.peakEquity)) * 100;
      if (dd > this.maxDrawdownPct) this.maxDrawdownPct = dd;
    }
  }

  metrics(): L2LiveFillEngineMetrics {
    const lastMid = this.lastMidMicros ?? MICROS;
    return {
      snapshots: this.snapshots,
      quotingSteps: this.quotingSteps,
      queueFills: this.queueFills,
      touchFills: this.touchFills,
      latencyBlockedFills: this.latencyBlockedFills,
      fillRatio: this.touchFills > 0 ? this.queueFills / this.touchFills : this.queueFills > 0 ? 1 : 0,
      bidFills: this.bidFills,
      askFills: this.askFills,
      realisedPnlUnits: this.book.realisedUnits(),
      finalInventoryUnits: this.book.inventoryUnits(),
      unrealisedPnlUnits: this.book.unrealisedUnits(lastMid),
      netPnlUnits: this.book.totalPnlUnits(lastMid),
      feesUnits: this.book.feesUnits(),
      maxDrawdownPct: this.maxDrawdownPct,
      attribution: sumComponents(this.components),
    };
  }

  /** The live inventory book (shared by reference with the MmBook — one source of truth). */
  inventory(): InventoryBook {
    return this.book;
  }

  /** Mid at the most recent snapshot (price-micros), or undefined before the first tick. */
  lastMid(): bigint | undefined {
    return this.lastMidMicros;
  }

  /** True once σ is warmed and the engine is quoting (the fast-path "warm" signal). */
  isQuoting(): boolean {
    return this.quotingSteps > 0;
  }
}
