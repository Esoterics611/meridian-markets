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
import { MarkoutTracker, MarkoutPoint } from '../microstructure/markout-tracker';
import { normCdf } from '../../derivatives/greeks/black-scholes';
import { IBiasSource, effectiveBias } from '../bias/bias-source.interface';
import { L2LiveFillEngine, ToxicityMetrics } from './l2-live-fill-engine';
import { LiveTick } from './l2-fill-engine-types';
import { IDeskEventSink, NULL_DESK_EVENT_SINK } from '../events/desk-event-sink';
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
   *  attribution column alongside spread and adverse. */
  inventoryCarryUnits: string;
  /** |inventory| cap in USDC-units (frac·capital); "0" when no notional cap is set.
   *  The UI shows exposure as a % of this rail. */
  inventoryNotionalCapUnits: string;
  /** Live VPIN (volume-synchronised toxicity) ∈ [0,1]; high = one-sided/informed flow. */
  vpin: number;
  /** VPIN buckets closed so far (the gauge is meaningful once this clears the EMA window). */
  vpinBuckets: number;
  /** Per-fill adverse-selection markout curve (avg bps at each forward horizon). */
  markout: MarkoutPoint[];
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
    return {
      book: this.book.serialize(),
      fundingUnits: this.fundingUnits.toString(),
      spreadCapturedUnits: this.spreadCaptured.toString(),
      adverseUnits: this.adverse.toString(),
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
    this.spreadCaptured = BigInt(s.spreadCapturedUnits);
    this.adverse = BigInt(s.adverseUnits);
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
    // VPIN feed (fast path): real per-interval aggressor prints — no BVC estimate needed.
    if (tick.flow) this.vpin.onClassifiedVolume(tick.flow.aggressiveBuyUnits ?? 0n, tick.flow.aggressiveSellUnits ?? 0n);
    const invBefore = this.book.inventoryUnits(); // carried-in inventory, for funding/carry
    const beforeBid = this._fastBidFills;
    const beforeAsk = this._fastAskFills;
    const quote = eng.onSnapshot(tick);
    if (quote) this.lastQuote = quote;
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
    const inv = this.book.inventoryUnits();
    if (inv === 0n || !this.lastBar) return;
    const midMicros = toMicros(this.lastBar.close);
    const side = inv > 0n ? 'SELL' : 'BUY';
    const size = inv > 0n ? inv : -inv;
    // Crossing the spread to flatten pays a taker fee (5 bps), not the maker rebate.
    const fee = (valueUnits(size, midMicros) * 5n) / 10_000n;
    this.book.apply({ side, sizeUnits: size, priceMicros: midMicros, feeUnits: fee });
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
      inventoryNotionalCapUnits: this.notionalCapUnits().toString(),
      vpin: this.vpin.current(),
      vpinBuckets: this.vpin.bucketsSeen(),
      markout: this.markout.curve(),
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
      spreadCapturedUnits: m.attribution.spreadCapturedUnits.toString(),
      adverseSelectionUnits: m.attribution.adverseSelectionUnits.toString(),
      inventoryCarryUnits: m.attribution.inventoryCarryUnits.toString(),
      inventoryNotionalCapUnits: this.notionalCapUnits().toString(),
      vpin: this.vpin.current(),
      vpinBuckets: this.vpin.bucketsSeen(),
      markout: m.markout,
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
