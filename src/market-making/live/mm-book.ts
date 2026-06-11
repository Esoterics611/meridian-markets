import { Logger } from '@nestjs/common';
import { Bar } from '../../stat-arb/backtest/bar';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair } from '../quote/quote-pair';
import { RollingVolatility } from '../quote/volatility';
import { InventoryBook, InventoryBookState } from '../inventory/inventory-book';
import { passiveFills } from '../backtest/fill-model';
import { attributeFill } from '../backtest/pnl-attribution';
import { RiskGate, RiskState, RiskVerdict } from '../risk/risk-gate';
import { VpinEstimator } from '../risk/vpin';
import { MarkoutTracker, MarkoutPoint, MarkoutSideCurves } from '../microstructure/markout-tracker';
import { normCdf } from '../../derivatives/greeks/black-scholes';
import { IBiasSource, effectiveBias } from '../bias/bias-source.interface';
import { L2LiveFillEngine, ToxicityMetrics } from './l2-live-fill-engine';
import { LiveTick } from './l2-fill-engine-types';
import { IDeskEventSink, NULL_DESK_EVENT_SINK } from '../events/desk-event-sink';
import { SweepRegimeDetector, RegimeState } from '../risk/sweep-regime-detector';
import { classifyFill, fillEvent, verdictEvent } from '../events/desk-event';

// MmBook — a single-instrument live paper market-making book. The market-making
// analogue of LivePaperTrader: on each tick it pulls the latest closed bar for
// its symbol from the real feed, computes the quote its IQuoter wants resting,
// runs the risk gate, simulates passive fills against the bar's range (paper
// matching — see fill-model.ts), and marks its inventory + P&L. The SAME IQuoter
// runs unchanged in the backtest; only the bar source differs, so paper results
// predict live behaviour — the seam the whole engine is built around.
//
// Feed + clock are injected (not a Nest dependency) so the book is unit-testable
// with a scripted bar list and no network. The module wires the real feed.

const MICROS = 1_000_000n;

function toMicros(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

export interface MmBookConfig {
  symbol: string;
  strategyId: string;
  /** Venue/source id ('hyperliquid'/'binance'/'geckoterminal'/…) for labels + telemetry. */
  source?: string;
  quoter: IQuoter;
  quoteSizeUnits: bigint;
  gamma: number;
  kappa: number;
  horizonBars: number;
  volWindowBars: number;
  volFloor: number;
  /** Maker fee in bps, SIGNED: negative = rebate. */
  makerFeeBps: number;
  /**
   * Perp funding rate as a SIGNED fraction per HOUR (+ ⇒ longs pay shorts, the HL
   * convention). When set, funding accrues each bar on the inventory held over the
   * interval, pro-rated by the real inter-bar time, into equity + net P&L (the same
   * 5th-line model as the queue-aware harness — MM course §8.10). Omit/0 ⇒ none
   * (spot/AMM venues have no funding). Static over the run unless refreshed.
   */
  fundingRatePerHour?: number;
  capitalUnits: bigint;
  /**
   * Notional inventory cap as a fraction of capital (Journal #41) — the same value the
   * quoter uses to bound |inventory| at frac·capital. Surfaced on the snapshot so the UI
   * can render "inventory as % of the rail". Omit/0 ⇒ no notional cap (lot-count only).
   */
  maxInventoryNotionalFrac?: number;
  /**
   * Warehouse loss-stop (Journal #55): when the unrealised MTM on the book's inventory
   * breaches −lossStopFrac·capital, the book FLATTENS at the mid (taker, 5bps), pulls its
   * quotes and stands aside for lossStopCooldownMs, then resumes flat. This is the desk's
   * answer to the "earn slowly on spread, lose suddenly on inventory" failure shape: the
   * governor caps inventory SIZE; this caps the LOSS a warehoused position may realise.
   * It does not add expectation — it converts a fat left tail into a bounded, known cost
   * (taker spread + fees per trigger). Omit/0 ⇒ off.
   */
  lossStopFrac?: number;
  /** Stand-aside duration after a loss-stop fires. Default 15 min. */
  lossStopCooldownMs?: number;
  /**
   * Session gate (Journal #55): UTC minutes-of-day window [openMin, closeMin) inside which
   * this book may quote. Outside the window the book flattens once and stands aside —
   * built for xyz equity-linked perps whose reference market is closed/stale off US RTH
   * (run53: every negative-fillEdge xyz read happened pre-US-open). Omit ⇒ quote 24h.
   */
  sessionUtc?: { openMin: number; closeMin: number };
  /**
   * Event-blackout windows (Journal #57): UTC minutes-of-day windows INSIDE which the book
   * flattens + stands aside (the inverse of sessionUtc) — scheduled-number protection (the
   * 13:30Z macro slot for CL/GOLD). Pro doctrine: nobody earns the spread through CPI.
   */
  blackoutUtc?: Array<{ openMin: number; closeMin: number }>;
  /**
   * S4 sweep-regime gate (Journal #56): one-sided aggressor flow + same-sign price drift ⇒
   * pull quotes BEFORE inventory builds against the move (the loss-stop fires after; this is
   * the before). Fast path only (needs the real per-tick aggressor flow). Omit ⇒ off.
   */
  regimeDetector?: SweepRegimeDetector;
  /** VPIN EMA window in buckets (toxicity gauge + risk pause). Default 50. */
  vpinEmaBuckets?: number;
  /** VPIN bucket size in asset units; default = quoteSizeUnits·10 (self-scales per symbol). */
  vpinBucketUnits?: bigint;
  /** Forward markout horizons in ms for the adverse-selection curve. Default 1s/5s/30s. */
  markoutHorizonsMs?: number[];
  /** Latest-closed-bar source (one bar per call, null when none new). */
  nextBar: (symbol: string) => Promise<Bar | null>;
  /**
   * Optional fast fair-value source (price-micros) for the quote CENTER — the live
   * F1 micro-price lever (FAIR_VALUE_AND_THESIS_DESIGN.md §Layer A). When set, each
   * tick passes it as `QuoteContext.referenceMicros` so the quoter centers on the
   * book-imbalance micro-price instead of the stale bar mid (spread width stays off
   * the mid — only the center moves), cutting adverse selection. null ⇒ fall back to
   * the bar mid (legacy). Wired for L2-capable venues (HL); omit for the rest.
   */
  referenceMicros?: (symbol: string) => Promise<bigint | null>;
  /**
   * Optional directional bias source (the axed maker's "house view" — DIRECTIONAL_MM
   * _STRATEGY.md). Each tick the book reads `biasSource.bias(symbol, ctx)` and passes
   * the OOS-GATED bias (0 unless the reading is validated) into the quote context as
   * `ctx.bias`, so the directional quoter rests at q* = bias·Q_max. Omit ⇒ no view
   * (neutral; every non-directional quoter ignores ctx.bias anyway).
   */
  biasSource?: IBiasSource;
  /**
   * Optional fast L2 fill engine (C2 — CADENCE_LIVE_LOOP_PLAN.md). When present this
   * book is on the FAST path: it is driven by L2 snapshots via onL2Snapshot() (the
   * poll driver), NOT by the bar tick (the trader skips it — the coexistence rule, so
   * a book is never on both paths). The book shares the engine's InventoryBook, and
   * snapshot() reads the engine's metrics. The DEFAULT for any L2-capable (HL) venue
   * (Journal #44 fast-only); a non-L2 venue is refused at launch, so the bar path runs
   * only in offline/unit tests.
   */
  fastEngine?: L2LiveFillEngine;
  /** Optional σ warmup: recent closes so the book quotes on its first live bar. */
  warmupCloses?: (symbol: string) => Promise<number[]>;
  riskGate?: RiskGate;
  now?: () => Date;
  /**
   * Business-event sink: a fill (enter/exit) + a risk-verdict change emit a
   * human-readable event here, rendered as a log line + buffered for the live
   * activity feed. No-op by default ⇒ the unit tests that build a book directly
   * are unchanged; the module injects the real DeskEventLog.
   */
  events?: IDeskEventSink;
}

/**
 * Persistable book state (ledger + all P&L accumulators), bigints as strings.
 * The quoter / feed / risk gate are NOT here — they are rebuilt from config on
 * restart; only the evolving P&L state needs to survive (restart-safe books).
 * The σ window is re-seeded from recent closes via warmup(), so it is not stored.
 */
export interface MmBookState {
  book: InventoryBookState;
  fundingUnits: string;
  spreadCapturedUnits: string;
  adverseUnits: string;
  /** MTM drift booked on carried inventory (diagnostic attribution). Optional for
   *  backward-compat with states persisted before this field existed. */
  inventoryCarryUnits?: string;
  /** Windowed (markout-horizon) carry from the fast engine's attribution — persisted so a
   *  finished run keeps its diagnostic split (S2; the S1 leak table found state reads 0). */
  windowedCarryUnits?: string;
  peakEquityUnits: string;
  maxDrawdownPct: number;
  barsSeen: number;
  fills: number;
  bidFills: number;
  askFills: number;
  blockedQuotes: number;
}

export interface MmBookSnapshot {
  symbol: string;
  strategyId: string;
  /** Venue/source id; '' for the default Binance feed. */
  source: string;
  family: string;
  running: boolean;
  warm: boolean;
  barsSeen: number;
  seededBars: number;
  lastBarAt: string | null;
  midMicros: string;
  bidMicros: string | null;
  askMicros: string | null;
  reservationMicros: string | null;
  halfSpreadMicros: string | null;
  inventoryUnits: string;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  feesUnits: string;
  /** Funding accrued on held inventory (+ received / − paid); "0" on non-perp venues. */
  fundingUnits: string;
  /** Live perp funding rate (signed fraction/hour) — drives the delta hedge's funding accrual. */
  fundingRatePerHour: number;
  netPnlUnits: string;
  spreadCapturedUnits: string;
  adverseSelectionUnits: string;
  /** MTM drift on inventory carried between bars (+ gain / − loss) — the third
   *  attribution column alongside spread and adverse. NOTE (S1): on the FAST path this is the
   *  engine's WINDOWED carry (post-fill markout horizons only) — a diagnostic, not an accounting
   *  term. Use inventoryMtmUnits for the term that sums. */
  inventoryCarryUnits: string;
  /** CONTINUOUS inventory mark-to-market: Σ inv_carried × Δmid over EVERY interval, fill to flat
   *  (accrueInterval, both drive paths; persisted). The warehouse-drift term that makes attribution
   *  SUM (Journal #49/#51 gap): net ≈ spreadCaptured − fees + funding + inventoryMtm, up to the
   *  quote→fill mid wedge the leak table reports as residual. */
  inventoryMtmUnits: string;
  /** |inventory| cap in USDC-units (frac·capital); "0" when no notional cap is set.
   *  The UI shows exposure as a % of this rail. */
  inventoryNotionalCapUnits: string;
  /** Live VPIN (volume-synchronised toxicity) ∈ [0,1]; high = one-sided/informed flow. */
  vpin: number;
  /** VPIN buckets closed so far (the gauge is meaningful once this clears the EMA window). */
  vpinBuckets: number;
  /** The estimator's EMA window in buckets — the UI greys the gauge until vpinBuckets clears it. */
  vpinWindowBuckets: number;
  /** Latest signed top-N book imbalance ∈ [−1,1] (fast path only; undefined on the bar path). */
  bookImbalance?: number;
  /** Latest signed aggressor-flow imbalance ∈ [−1,1] (fast path only; undefined on the bar path). */
  tradeFlowImbalance?: number;
  /** The bias the quoter was ACTUALLY handed last tick (post OOS-gate; 0 = neutral, no lean).
   *  A sign flip here is "the front of the move flipped" — the UI renders it per book. */
  bias?: number;
  /** S4 sweep-regime state: 'calm' (quoting) / 'sweep' (one-sided flow + drift — quotes pulled)
   *  / 'cooldown' (re-entry hold). Undefined ⇒ gate not wired for this book. */
  regime?: RegimeState;
  /** Delta-hedge coverage (Journal #55b, annotated by the portfolio trader): the hedge leg's
   *  underlying + β, or β=0/undefined ⇒ NAKED. Makes "are we delta-neutral?" explicit on every
   *  snapshot — the run53 lesson (the xyz books were unhedged and nothing said so). */
  hedgeUnderlying?: string;
  hedgeBeta?: number;
  /** Per-fill adverse-selection markout curve (avg bps at each forward horizon). */
  markout: MarkoutPoint[];
  /** The markout curve split by fill side (WP2) — asymmetry = one-sided informed flow. */
  markoutBySide: MarkoutSideCurves;
  /** F3 toxicity spread-scaler diagnostics (fast path only; undefined on the bar path / when
   *  the defence is off). Confirms the adverse-selection defence fired (Journal #44 DR-3). */
  toxicity?: ToxicityMetrics;
  fills: number;
  bidFills: number;
  askFills: number;
  blockedQuotes: number;
  lastVerdict: string;
  maxDrawdownPct: number;
}

export class MmBook {
  private readonly logger = new Logger(MmBook.name);
  private readonly vol: RollingVolatility;
  /** Guardrail stand-aside horizon (epoch ms) after a loss-stop fires; 0 = not standing aside. */
  private standAsideUntilMs = 0;
  /** S4 regime state last tick (transition logging + the snapshot's regime field). */
  private lastRegime: RegimeState = 'calm';
  /** Count of loss-stop triggers this run (surfaced in logs; the leak table greps the line). */
  private lossStops = 0;
  // On the fast L2 path the book is SHARED with the fill engine (one source of truth —
  // the engine fills into it, snapshot() reads it). On the bar path it's our own.
  private readonly book: InventoryBook;
  private readonly now: () => Date;
  private readonly events: IDeskEventSink;

  private barsSeen = 0;
  private seededBars = 0;
  private lastBar: Bar | null = null;
  private lastQuote: QuotePair | null = null;
  private fills = 0;
  private bidFills = 0;
  private askFills = 0;
  // Fast-path fill-count cursors (for emitting one DeskEvent per new engine fill).
  private _fastBidFills = 0;
  private _fastAskFills = 0;
  private blockedQuotes = 0;
  private spreadCaptured = 0n;
  private adverse = 0n;
  /** MTM drift on inventory carried across bars (+ gain / − loss). Diagnostic
   *  attribution; already inside realised/unrealised, not added to net again. */
  private inventoryCarry = 0n;
  /** Restored windowed-attribution baseline for FAST books: the engine restarts at zero on
   *  rehydrate, so checkpoints/snapshots report base + engine (windowed split survives
   *  restarts and reaches mm_book_state — the S1 leak-table gap). Bar books don't use it. */
  private attribBase = { spread: 0n, adverse: 0n, carry: 0n };
  /** Funding harvested (+) / paid (−) on held inventory over the run; 0 when no rate. */
  private fundingUnits = 0n;
  /** Live toxicity gauge — fed by BVC on the bar path, real aggressor flow on the fast path. */
  private readonly vpin: VpinEstimator;
  /** Forward markout curve for bar-path books (the fast path uses the engine's tracker). */
  private readonly markout: MarkoutTracker;
  private prevBarMs: number | undefined;
  private prevMidMicros: bigint | undefined;
  private peakEquity: bigint;
  private maxDrawdownPct = 0;
  private lastVerdict: RiskVerdict['kind'] = 'Allow';
  private running = false;
  private warmedUp = false;
  /** Fill recorded last bar, awaiting a mark-out against this bar's mid. */
  private pendingMarkout: { side: 'BUY' | 'SELL'; sizeUnits: bigint; fairMid: bigint }[] = [];

  constructor(private cfg: MmBookConfig) {
    this.vol = new RollingVolatility(cfg.volWindowBars);
    this.book = cfg.fastEngine ? cfg.fastEngine.inventory() : new InventoryBook();
    this.now = cfg.now ?? (() => new Date());
    this.events = cfg.events ?? NULL_DESK_EVENT_SINK;
    this.peakEquity = cfg.capitalUnits;
    // Bucket size self-scales off the book's own quote size so one knob fits a
    // 100×-price universe (DOGE's quoteSize in asset units ≫ BTC's). Override via cfg.
    const bucket = cfg.vpinBucketUnits && cfg.vpinBucketUnits > 0n ? cfg.vpinBucketUnits : cfg.quoteSizeUnits * 10n;
    this.vpin = new VpinEstimator({
      bucketVolumeUnits: bucket > 0n ? bucket : 1_000_000n,
      emaWindowBuckets: cfg.vpinEmaBuckets ?? 50,
    });
    this.markout = new MarkoutTracker(cfg.markoutHorizonsMs ?? [1000, 5000, 30000]);
    // WP2: the fast engine reads the book's VPIN (risk gate + shadow capture). Wired here so the
    // rehydrate path gets it too — the estimator is volume-bucketed across BOTH fill paths.
    if (cfg.fastEngine) cfg.fastEngine.vpinProvider = () => this.vpin.current();
  }

  setRunning(v: boolean): void {
    this.running = v;
  }

  setCapital(units: bigint): void {
    if (units <= 0n) throw new Error('mm book capital must be positive');
    this.cfg = { ...this.cfg, capitalUnits: units };
    this.peakEquity = units;
  }

  /** Refresh the live perp funding rate (signed fraction/hour). Lets a scheduler keep
   *  the static-per-run rate current as funding drifts over a multi-hour session. */
  setFundingRatePerHour(rate: number): void {
    this.cfg = { ...this.cfg, fundingRatePerHour: rate };
    // On the fast path the engine holds the funding input the bias reads — keep it live.
    this.cfg.fastEngine?.setFundingRatePerHour(rate);
  }

  /** The resolved numeric config needed to persist + rebuild this book on restart. */
  config(): {
    strategyId: string;
    quoteSizeUnits: bigint;
    gamma: number;
    kappa: number;
    horizonBars: number;
    volWindowBars: number;
    volFloor: number;
    makerFeeBps: number;
    fundingRatePerHour: number;
    capitalUnits: bigint;
  } {
    return {
      strategyId: this.cfg.strategyId,
      quoteSizeUnits: this.cfg.quoteSizeUnits,
      gamma: this.cfg.gamma,
      kappa: this.cfg.kappa,
      horizonBars: this.cfg.horizonBars,
      volWindowBars: this.cfg.volWindowBars,
      volFloor: this.cfg.volFloor,
      makerFeeBps: this.cfg.makerFeeBps,
      fundingRatePerHour: this.cfg.fundingRatePerHour ?? 0,
      capitalUnits: this.cfg.capitalUnits,
    };
  }

  /** |inventory| cap in USDC-units (frac·capital); 0n when no notional cap is configured. */
  private notionalCapUnits(): bigint {
    const frac = this.cfg.maxInventoryNotionalFrac;
    if (!frac || frac <= 0) return 0n;
    return BigInt(Math.round(frac * Number(this.cfg.capitalUnits)));
  }

  /** Snapshot the evolving P&L state for persistence (restart-safe books). */
  serializeState(): MmBookState {
    const a = this.cfg.fastEngine?.metrics().attribution;
    const spread = a ? this.attribBase.spread + a.spreadCapturedUnits : this.spreadCaptured;
    const adverse = a ? this.attribBase.adverse + a.adverseSelectionUnits : this.adverse;
    const windowedCarry = a ? this.attribBase.carry + a.inventoryCarryUnits : 0n;
    return {
      book: this.book.serialize(),
      fundingUnits: this.fundingUnits.toString(),
      spreadCapturedUnits: spread.toString(),
      adverseUnits: adverse.toString(),
      windowedCarryUnits: windowedCarry.toString(),
      inventoryCarryUnits: this.inventoryCarry.toString(),
      peakEquityUnits: this.peakEquity.toString(),
      maxDrawdownPct: this.maxDrawdownPct,
      barsSeen: this.barsSeen,
      fills: this.fills,
      bidFills: this.bidFills,
      askFills: this.askFills,
      blockedQuotes: this.blockedQuotes,
    };
  }

  /** Restore a previously-persisted state onto a freshly-built book (post-construct,
   *  before the first tick). The book then re-warms σ from warmup() and resumes. */
  restore(s: MmBookState): void {
    this.book.restore(s.book);
    this.fundingUnits = BigInt(s.fundingUnits);
    if (this.cfg.fastEngine) {
      // The engine restarts at zero — carry the persisted windowed attribution as a baseline.
      this.attribBase = {
        spread: BigInt(s.spreadCapturedUnits),
        adverse: BigInt(s.adverseUnits),
        carry: BigInt(s.windowedCarryUnits ?? '0'),
      };
    } else {
      this.spreadCaptured = BigInt(s.spreadCapturedUnits);
      this.adverse = BigInt(s.adverseUnits);
    }
    this.inventoryCarry = BigInt(s.inventoryCarryUnits ?? '0');
    this.peakEquity = BigInt(s.peakEquityUnits);
    this.maxDrawdownPct = s.maxDrawdownPct;
    this.barsSeen = s.barsSeen;
    this.fills = s.fills;
    this.bidFills = s.bidFills;
    this.askFills = s.askFills;
    this.blockedQuotes = s.blockedQuotes;
  }

  /** Seed the σ window from recent closes so the book can quote immediately. */
  async warmup(): Promise<void> {
    if (this.warmedUp || !this.cfg.warmupCloses) return;
    try {
      const closes = await this.cfg.warmupCloses(this.cfg.symbol);
      for (const c of closes) {
        this.vol.push(c);
        this.seededBars += 1;
      }
      // On the fast path the engine owns the σ window it quotes off — seed it too.
      if (this.cfg.fastEngine) this.cfg.fastEngine.warmup(closes);
      this.warmedUp = true;
    } catch (e) {
      this.logger.warn(`warmup failed for ${this.cfg.symbol}: ${(e as Error).message}`);
    }
  }

  /** True when this book is on the fast L2 path (driven by onL2Snapshot, not the bar tick). */
  isFastPath(): boolean {
    return !!this.cfg.fastEngine;
  }

  /**
   * Fast-path drive (C2): feed one live L2 snapshot to the engine and surface the new
   * resting quote + fills. Fills land in the SHARED InventoryBook; a fill-count delta
   * emits the same fill DeskEvent the bar path emits, so the Activity tape + NAV show
   * fast-path trades identically. No-op when this book is not on the fast path.
   */
  onL2Snapshot(tick: LiveTick): void {
    const eng = this.cfg.fastEngine;
    if (!eng || !this.running) return;
    // Guardrails first (Journal #55): session gate + warehouse loss-stop. Priced off the
    // PREVIOUS tick's mid (the engine has no mid before its first snapshot — that first
    // tick passes ungated, which only matters for a book launched outside its session).
    const guardMid = eng.lastMid();
    if (guardMid !== undefined && this.guardrail(this.now().getTime(), guardMid)) {
      eng.cancelResting(); // pull both quotes; no resting orders ⇒ no fills while standing aside
      return;
    }
    // VPIN feed (fast path): real per-interval aggressor prints — no BVC estimate needed.
    if (tick.flow) this.vpin.onClassifiedVolume(tick.flow.aggressiveBuyUnits ?? 0n, tick.flow.aggressiveSellUnits ?? 0n);
    const invBefore = this.book.inventoryUnits(); // carried-in inventory, for funding/carry
    const beforeBid = this._fastBidFills;
    const beforeAsk = this._fastAskFills;
    const quote = eng.onSnapshot(tick);
    if (quote) this.lastQuote = quote;
    // S4 sweep-regime gate (Journal #56): drive the detector off this tick's REAL aggressor
    // flow + the fresh mid. In 'sweep'/'cooldown' the quotes the engine just re-placed are
    // pulled immediately — nothing rests into the sweep, so nothing fills against it, while
    // the engine's σ/markout/funding state stays warm (unlike the session-gate full skip).
    if (this.cfg.regimeDetector) {
      const m0 = eng.lastMid() ?? 0n;
      const state = this.cfg.regimeDetector.update(
        this.now().getTime(),
        m0,
        tick.flow?.aggressiveBuyUnits ?? 0n,
        tick.flow?.aggressiveSellUnits ?? 0n,
      );
      if (state !== this.lastRegime) {
        this.logger.warn(
          `REGIME ▸ ${this.cfg.symbol} ${this.lastRegime} → ${state}` +
            (state === 'sweep' ? ` (flow ${this.cfg.regimeDetector.flow().toFixed(2)} — quotes pulled before inventory builds)` : ''),
        );
        this.events.emit(verdictEvent({ ts: this.now().getTime(), book: this.cfg.symbol, source: this.cfg.source ?? '', prev: `regime:${this.lastRegime}`, next: `regime:${state}` }));
        this.lastRegime = state;
      }
      if (state !== 'calm') {
        eng.cancelResting();
        this.blockedQuotes += 1;
        return;
      }
    }
    const m = eng.metrics();
    this._fastBidFills = m.bidFills;
    this._fastAskFills = m.askFills;
    const mid = eng.lastMid() ?? MICROS;
    // Funding accrual on the carried-in inventory — the ONE term the fast path was missing (the
    // engine already computes realised/unrealised/fees + spread/adverse/carry/markout/maxDD).
    // Uses the wall clock since L2 snapshots carry no timestamp; fastSnapshot surfaces fundingUnits.
    this.accrueInterval(this.now().getTime(), mid, invBefore);
    // Emit a fill event per new fill (side from the count delta, price from the resting
    // quote on that side). The realised P&L is read from the shared book.
    for (let i = beforeBid; i < m.bidFills && quote; i++) this.emitFastFill('BUY', quote.bid.priceMicros, mid);
    for (let i = beforeAsk; i < m.askFills && quote; i++) this.emitFastFill('SELL', quote.ask.priceMicros, mid);
  }

  private emitFastFill(side: 'BUY' | 'SELL', priceMicros: bigint, _mid: bigint): void {
    this.events.emit(
      fillEvent({
        ts: this.now().getTime(),
        book: this.cfg.symbol,
        source: this.cfg.source ?? '',
        side,
        action: classifyFill(0n, this.book.inventoryUnits()),
        sizeUnits: this.cfg.quoteSizeUnits,
        priceMicros,
        inventoryUnits: this.book.inventoryUnits(),
        realisedDeltaUnits: 0n,
        feeUnits: 0n,
      }),
    );
  }

  /**
   * Per-interval bookkeeping shared by BOTH drive paths (bar tick + fast L2 snapshot): accrue
   * funding on the inventory carried INTO the interval, mark the inventory-carry attribution, and
   * advance the inter-update cursor. `invUnits` is that carried-in inventory (captured before this
   * interval's fills); `midMicros` is this interval's mid. Flat/warming (inv 0) ⇒ funding/carry are
   * no-ops. Funding: −(signed inv notional)·rate·Δt (a long pays a positive rate). Rounding is safe
   * at desk-scale notional even at 100ms (per-step accrual ≫ 1 unit). NOTE: fast-path books surface
   * the ENGINE's carry attribution (fastSnapshot reads m.attribution), so the carry accumulated here
   * is used by the bar path only — funding is the term the fast path was missing (it hard-coded 0).
   */
  private accrueInterval(tsMs: number, midMicros: bigint, invUnits: bigint): void {
    if (this.prevBarMs !== undefined && this.prevMidMicros !== undefined && invUnits !== 0n) {
      const fundingRate = this.cfg.fundingRatePerHour ?? 0;
      const dtHours = (tsMs - this.prevBarMs) / 3_600_000;
      if (fundingRate !== 0 && dtHours > 0) {
        const notional = (invUnits * this.prevMidMicros) / MICROS;
        this.fundingUnits += BigInt(Math.round(-Number(notional) * fundingRate * dtHours));
      }
      this.inventoryCarry += (invUnits * (midMicros - this.prevMidMicros)) / MICROS;
    }
    this.prevBarMs = tsMs;
    this.prevMidMicros = midMicros;
  }

  /** One iteration: pull the latest closed bar and act on it. No-op if none new. */
  async tick(): Promise<void> {
    if (this.cfg.fastEngine) return; // fast-path books are driven by onL2Snapshot, never the bar tick
    const bar = await this.cfg.nextBar(this.cfg.symbol);
    if (!bar) return;
    this.barsSeen += 1;
    this.lastBar = bar;
    const midMicros = toMicros(bar.close);
    this.vol.push(bar.close);

    const tsMs = bar.timestamp.getTime();
    // VPIN feed (bar path): classify this bar's volume into buy/sell via Bulk Volume
    // Classification (BVC, ELO12) — buyFrac = Φ(standardised return) — then bucket it. Runs
    // FIRST, while prevMidMicros still holds the previous bar's mid (accrueInterval moves it).
    // Needs a warm σ for the standardisation; while warming, VPIN simply stays at 0.
    const sigma = this.vol.value();
    if (this.prevMidMicros !== undefined && Number.isFinite(sigma) && sigma > 0 && bar.volume > 0) {
      const ret = Math.log(Number(midMicros) / Number(this.prevMidMicros));
      const buyFrac = normCdf(ret / sigma);
      const volUnits = BigInt(Math.round(bar.volume * 1e6));
      const buyUnits = BigInt(Math.round(Number(volUnits) * buyFrac));
      this.vpin.onClassifiedVolume(buyUnits, volUnits - buyUnits);
    }
    // Re-mark prior fills against this bar's mid (the forward markout curve).
    this.markout.onMid(tsMs, midMicros);
    // Funding + inventory-carry on the inventory carried into this bar, then advance the cursor.
    // (Shared with the fast L2 path — the one place funding accrues. MM course §8.10.)
    this.accrueInterval(tsMs, midMicros, this.book.inventoryUnits());

    // Resolve any prior-bar fills' adverse selection against this bar's mid.
    for (const p of this.pendingMarkout) {
      const c = attributeFill({ side: p.side, sizeUnits: p.sizeUnits, priceMicros: p.fairMid, feeUnits: 0n }, p.fairMid, midMicros, 0n);
      this.adverse += c.adverseSelectionUnits;
    }
    this.pendingMarkout = [];

    // Guardrails (Journal #55): session gate + warehouse loss-stop — flatten + stand aside.
    if (this.guardrail(tsMs, midMicros)) {
      this.markEquity(midMicros);
      return;
    }

    if (!this.vol.ready()) return; // warming

    const inventoryBefore = this.book.inventoryUnits();
    // F1 live: center the quote on the order-book micro-price when a fast fair-value
    // source is wired (HL L2), else on the bar mid (legacy). Best-effort — a failed
    // L2 fetch falls back to the mid, never skips the tick. Only the CENTER moves;
    // the spread width + rails stay scaled off midMicros inside the quoter.
    let referenceMicros: bigint | undefined;
    if (this.cfg.referenceMicros) {
      const ref = await this.cfg.referenceMicros(this.cfg.symbol).catch(() => null);
      if (ref !== null && ref > 0n) referenceMicros = ref;
    }
    // Directional bias (the axe): an OOS-gated per-tick view from the bias source.
    // effectiveBias() returns 0 for an unvalidated reading, so a blind/unproven view
    // never sizes carry — the honesty gate. Only the directional quoter reads ctx.bias.
    let bias: number | undefined;
    if (this.cfg.biasSource) {
      bias = effectiveBias(
        this.cfg.biasSource.bias(this.cfg.symbol, {
          fundingRatePerHour: this.cfg.fundingRatePerHour ?? 0,
          nowMs: this.now().getTime(),
        }),
      );
    }
    const ctx: QuoteContext = {
      inventoryUnits: inventoryBefore,
      midMicros,
      referenceMicros,
      bias,
      nowMs: tsMs,
      volatility: this.vol.valueOr(this.cfg.volFloor),
      riskAversion: this.cfg.gamma,
      arrivalDecay: this.cfg.kappa,
      horizonBars: this.cfg.horizonBars,
      schemaVersion: 1,
    };
    const quote = this.cfg.quoter.quote(ctx, this.cfg.symbol);
    this.lastQuote = quote;

    if (this.cfg.riskGate) {
      const navRatio = Number(this.equityWithFunding(midMicros)) / Number(this.cfg.capitalUnits);
      const state: RiskState = { inventoryUnits: inventoryBefore, navRatio, vpin: this.vpin.current(), recentAdverseUnits: this.adverse, killed: false };
      const verdict = this.cfg.riskGate.check(quote, state);
      // Emit a business event only on a verdict TRANSITION (Allow ⇄ Pause ⇄ Deny),
      // not every blocked tick — the operator wants the state change, not a flood.
      if (verdict.kind !== this.lastVerdict) {
        this.events.emit(verdictEvent({ ts: this.now().getTime(), book: this.cfg.symbol, source: this.cfg.source ?? '', prev: this.lastVerdict, next: verdict.kind }));
      }
      this.lastVerdict = verdict.kind;
      if (verdict.kind !== 'Allow') {
        this.blockedQuotes += 1;
        this.markEquity(midMicros);
        return;
      }
    }

    const res = passiveFills(bar, quote.bid.priceMicros, quote.ask.priceMicros);
    const feeFor = (notionalUnits: bigint): bigint => (notionalUnits * BigInt(Math.round(this.cfg.makerFeeBps * 100))) / 1_000_000n;
    const applyOne = (side: 'BUY' | 'SELL', priceMicros: bigint): void => {
      const fee = feeFor(valueUnits(this.cfg.quoteSizeUnits, priceMicros));
      const invBefore = this.book.inventoryUnits();
      const realisedBefore = this.book.realisedUnits();
      this.book.apply({ side, sizeUnits: this.cfg.quoteSizeUnits, priceMicros, feeUnits: fee });
      const invAfter = this.book.inventoryUnits();
      const c = attributeFill({ side, sizeUnits: this.cfg.quoteSizeUnits, priceMicros, feeUnits: fee }, midMicros, midMicros, 0n);
      this.spreadCaptured += c.spreadCapturedUnits;
      this.fills += 1;
      // Defer adverse selection to next bar's mid (a one-bar mark-out).
      this.pendingMarkout.push({ side, sizeUnits: this.cfg.quoteSizeUnits, fairMid: priceMicros });
      // Record the fill for the multi-horizon markout curve (marked vs the fill-time mid).
      this.markout.onFill(side, midMicros, tsMs);
      // The business event: a trade entered/exited inventory (enter = open/add,
      // exit = reduce/close/flip, with the realised P&L the exit just booked).
      this.events.emit(
        fillEvent({
          ts: this.now().getTime(),
          book: this.cfg.symbol,
          source: this.cfg.source ?? '',
          side,
          action: classifyFill(invBefore, invAfter),
          sizeUnits: this.cfg.quoteSizeUnits,
          priceMicros,
          inventoryUnits: invAfter,
          realisedDeltaUnits: this.book.realisedUnits() - realisedBefore,
          feeUnits: fee,
        }),
      );
    };
    if (res.bidFilled) {
      applyOne('BUY', quote.bid.priceMicros);
      this.bidFills += 1;
    }
    if (res.askFilled) {
      applyOne('SELL', quote.ask.priceMicros);
      this.askFills += 1;
    }
    this.markEquity(midMicros);
  }

  /** Force inventory to zero at the last mid (taker flatten; manual desk action). */
  async flatten(): Promise<void> {
    const midMicros = this.cfg.fastEngine?.lastMid() ?? (this.lastBar ? toMicros(this.lastBar.close) : undefined);
    if (midMicros !== undefined) this.flattenAt(midMicros, 'manual');
  }

  /** Taker-flatten the inventory at `midMicros` (5bps taker fee, not the rebate) and emit the
   *  exit as a business event — a guardrail flatten is a real trade, it goes on the tape. */
  private flattenAt(midMicros: bigint, reason: 'loss-stop' | 'session-close' | 'event-blackout' | 'manual'): void {
    const inv = this.book.inventoryUnits();
    if (inv === 0n || midMicros <= 0n) return;
    const side = inv > 0n ? 'SELL' : 'BUY';
    const size = inv > 0n ? inv : -inv;
    // Crossing the spread to flatten pays a taker fee (5 bps), not the maker rebate.
    const fee = (valueUnits(size, midMicros) * 5n) / 10_000n;
    const realisedBefore = this.book.realisedUnits();
    this.book.apply({ side, sizeUnits: size, priceMicros: midMicros, feeUnits: fee });
    const realisedDelta = this.book.realisedUnits() - realisedBefore;
    this.logger.warn(
      `GUARDRAIL ▸ ${this.cfg.symbol} ${reason}: flattened ${side} ${size} units @ mid (taker), realised ${realisedDelta} units`,
    );
    this.events.emit(
      fillEvent({
        ts: this.now().getTime(),
        book: this.cfg.symbol,
        source: this.cfg.source ?? '',
        side,
        action: classifyFill(inv, 0n),
        sizeUnits: size,
        priceMicros: midMicros,
        inventoryUnits: 0n,
        realisedDeltaUnits: realisedDelta,
        feeUnits: fee,
      }),
    );
  }

  /**
   * The per-interval guardrails (Journal #55) — session gate + warehouse loss-stop. Returns
   * true when the book must STAND ASIDE this interval (caller pulls quotes and skips the
   * quoting path). Runs on BOTH drive paths, before any quote is computed:
   *   1. session gate: outside [openMin, closeMin) UTC ⇒ flatten once + stand aside (a stale
   *      reference market is pure pick-off; run53 SKHX fillEdge −$632 was all pre-US-open);
   *   2. loss-stop cooldown: a fired stop keeps quotes pulled until the horizon passes;
   *   3. loss-stop: unrealised on inventory < −lossStopFrac·capital ⇒ flatten at taker +
   *      cooldown. Caps what a warehoused position may LOSE (the governor only caps its size).
   */
  private guardrail(nowMs: number, midMicros: bigint): boolean {
    const minOfDay = Math.floor((nowMs % 86_400_000) / 60_000);
    const s = this.cfg.sessionUtc;
    if (s) {
      const inSession = minOfDay >= s.openMin && minOfDay < s.closeMin;
      if (!inSession) {
        this.flattenAt(midMicros, 'session-close');
        return true;
      }
    }
    // Event blackout (Journal #57): INSIDE any window ⇒ flat + aside (scheduled-number risk).
    for (const w of this.cfg.blackoutUtc ?? []) {
      if (minOfDay >= w.openMin && minOfDay < w.closeMin) {
        this.flattenAt(midMicros, 'event-blackout');
        return true;
      }
    }
    if (nowMs < this.standAsideUntilMs) return true;
    const frac = this.cfg.lossStopFrac;
    if (frac && frac > 0 && this.book.inventoryUnits() !== 0n) {
      const stopUnits = BigInt(Math.round(frac * Number(this.cfg.capitalUnits)));
      if (this.book.unrealisedUnits(midMicros) < -stopUnits) {
        this.lossStops += 1;
        this.flattenAt(midMicros, 'loss-stop');
        this.standAsideUntilMs = nowMs + (this.cfg.lossStopCooldownMs ?? 900_000);
        return true;
      }
    }
    return false;
  }

  /** Equity including funding: capital + trading P&L + funding accrued. */
  private equityWithFunding(midMicros: bigint): bigint {
    return this.book.equityUnits(this.cfg.capitalUnits, midMicros) + this.fundingUnits;
  }

  private markEquity(midMicros: bigint): void {
    const equity = this.equityWithFunding(midMicros);
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity > 0n) {
      const ddPct = (Number(this.peakEquity - equity) / Number(this.peakEquity)) * 100;
      if (ddPct > this.maxDrawdownPct) this.maxDrawdownPct = ddPct;
    }
  }

  snapshot(): MmBookSnapshot {
    if (this.cfg.fastEngine) return this.fastSnapshot(this.cfg.fastEngine);
    const midMicros = this.lastBar ? toMicros(this.lastBar.close) : MICROS;
    const q = this.lastQuote;
    return {
      symbol: this.cfg.symbol,
      strategyId: this.cfg.strategyId,
      source: this.cfg.source ?? '',
      family: this.cfg.quoter.familyId,
      running: this.running,
      warm: this.vol.ready(),
      barsSeen: this.barsSeen,
      seededBars: this.seededBars,
      lastBarAt: this.lastBar ? this.lastBar.timestamp.toISOString() : null,
      midMicros: midMicros.toString(),
      bidMicros: q ? q.bid.priceMicros.toString() : null,
      askMicros: q ? q.ask.priceMicros.toString() : null,
      reservationMicros: q ? q.reservationMicros.toString() : null,
      halfSpreadMicros: q ? q.halfSpreadMicros.toString() : null,
      inventoryUnits: this.book.inventoryUnits().toString(),
      capitalUnits: this.cfg.capitalUnits.toString(),
      equityUnits: this.equityWithFunding(midMicros).toString(),
      realisedPnlUnits: this.book.realisedUnits().toString(),
      unrealisedPnlUnits: this.book.unrealisedUnits(midMicros).toString(),
      feesUnits: this.book.feesUnits().toString(),
      fundingUnits: this.fundingUnits.toString(),
      fundingRatePerHour: this.cfg.fundingRatePerHour ?? 0,
      netPnlUnits: (this.book.totalPnlUnits(midMicros) + this.fundingUnits).toString(),
      spreadCapturedUnits: this.spreadCaptured.toString(),
      adverseSelectionUnits: this.adverse.toString(),
      inventoryCarryUnits: this.inventoryCarry.toString(),
      inventoryMtmUnits: this.inventoryCarry.toString(), // bar path: carry IS the continuous term
      inventoryNotionalCapUnits: this.notionalCapUnits().toString(),
      vpin: this.vpin.current(),
      vpinBuckets: this.vpin.bucketsSeen(),
      vpinWindowBuckets: this.vpin.windowBuckets(),
      markout: this.markout.curve(),
      markoutBySide: this.markout.sideCurves(),
      fills: this.fills,
      bidFills: this.bidFills,
      askFills: this.askFills,
      blockedQuotes: this.blockedQuotes,
      lastVerdict: this.lastVerdict,
      maxDrawdownPct: this.maxDrawdownPct,
    };
  }

  /** The snapshot for a fast-path book — read from the engine (the single source of truth for
   *  that book's queue-aware realised/unrealised/fees + spread/adverse/carry/markout/maxDD), PLUS
   *  the funding MmBook accrues on the side (accrueInterval) and folds into net/equity here. */
  private fastSnapshot(eng: L2LiveFillEngine): MmBookSnapshot {
    const m = eng.metrics();
    const mid = eng.lastMid() ?? MICROS;
    const q = this.lastQuote;
    return {
      symbol: this.cfg.symbol,
      strategyId: this.cfg.strategyId,
      source: this.cfg.source ?? '',
      family: this.cfg.quoter.familyId,
      running: this.running,
      warm: eng.isQuoting(),
      barsSeen: m.snapshots,
      seededBars: this.seededBars,
      lastBarAt: null,
      midMicros: mid.toString(),
      bidMicros: q ? q.bid.priceMicros.toString() : null,
      askMicros: q ? q.ask.priceMicros.toString() : null,
      reservationMicros: q ? q.reservationMicros.toString() : null,
      halfSpreadMicros: q ? q.halfSpreadMicros.toString() : null,
      inventoryUnits: m.finalInventoryUnits.toString(),
      capitalUnits: this.cfg.capitalUnits.toString(),
      // Funding is accrued by MmBook (accrueInterval), the engine owns the rest of the P&L — so
      // the fast desk net = engine net + funding, mirroring the bar path's book.totalPnl + funding.
      equityUnits: (this.cfg.capitalUnits + m.netPnlUnits + this.fundingUnits).toString(),
      realisedPnlUnits: m.realisedPnlUnits.toString(),
      unrealisedPnlUnits: m.unrealisedPnlUnits.toString(),
      feesUnits: m.feesUnits.toString(),
      fundingUnits: this.fundingUnits.toString(),
      fundingRatePerHour: this.cfg.fundingRatePerHour ?? 0,
      netPnlUnits: (m.netPnlUnits + this.fundingUnits).toString(),
      spreadCapturedUnits: (this.attribBase.spread + m.attribution.spreadCapturedUnits).toString(),
      adverseSelectionUnits: (this.attribBase.adverse + m.attribution.adverseSelectionUnits).toString(),
      inventoryCarryUnits: (this.attribBase.carry + m.attribution.inventoryCarryUnits).toString(),
      // The S1 fix: accrueInterval has computed (and persisted) this continuous MTM all along on
      // the fast path too — it was just never surfaced, leaving warehouse drift in NO component.
      inventoryMtmUnits: this.inventoryCarry.toString(),
      inventoryNotionalCapUnits: this.notionalCapUnits().toString(),
      vpin: this.vpin.current(),
      vpinBuckets: this.vpin.bucketsSeen(),
      vpinWindowBuckets: this.vpin.windowBuckets(),
      bookImbalance: m.bookImbalance,
      bias: m.bias,
      regime: this.cfg.regimeDetector ? this.lastRegime : undefined,
      tradeFlowImbalance: m.tradeFlowImbalance,
      markout: m.markout,
      markoutBySide: m.markoutBySide,
      toxicity: m.toxicity,
      fills: m.queueFills,
      bidFills: m.bidFills,
      askFills: m.askFills,
      blockedQuotes: this.blockedQuotes,
      lastVerdict: this.lastVerdict,
      maxDrawdownPct: m.maxDrawdownPct,
    };
  }
}
