import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext } from '../quote/quote-pair';
import { RollingVolatility } from '../quote/volatility';
import { InventoryBook, FillSide } from '../inventory/inventory-book';
import { attributeFill, PnlComponent, sumComponents, AttributionSummary } from './pnl-attribution';
import { QueuePosition } from './queue-model';
import { RiskGate, RiskState } from '../risk/risk-gate';
import { OrderBook, midMicros } from '../microstructure/order-book';
import { MicroPriceCalculator } from '../microstructure/micro-price';
import { crossVenueReference } from '../microstructure/cross-venue';
import { FlowToxicityScaler } from '../microstructure/flow-toxicity';
import { L2TapeStep, bestBidMicros, bestAskMicros } from './l2-tape';
import { RestingQuote, settleRestingOrder, placeRestingOrder, decideRequote, RequoteHysteresisCfg } from './queue-fill';

// LobReplayHarness — the queue-aware market-making backtest (course A.10). It is
// the honest counterpart to MmBacktestRunner: where the bar runner fills on touch
// (the instant a quote price is reached, assuming we're alone at the front of the
// queue — an UPPER BOUND on fills), this replays a real L2 depth tape and only
// fills a resting maker order once the size that was AHEAD of it at its price
// level has actually been consumed by aggressive flow (FIFO). On a liquid book
// that is a different, far smaller, and TRUE number of fills.
//
// The single number this exists to produce: queueFills vs touchFills — how much
// the fill-on-touch model overstated. Everything else (the four P&L components,
// drawdown) is computed on the queue-aware fills, so the structural net is finally
// judged against fills we could actually have gotten.
//
// THE FILL RULE (per side, per step), stated so the simplification is auditable:
//   - A maker order joins the back of its price level; aheadUnits = the size
//     already resting there when we joined (SimpleQueueModel.enqueue).
//   - Over the interval to the next snapshot, `aggressive*Units` taker flow on the
//     opposite side arrives. FIFO: it first consumes the queue ahead of us, then
//     fills us. filled = max(0, aggressiveVolume − aheadUnits), capped at our size,
//     and only if a trade actually reached our price (the touch gate).
//   - An order at an UNCHANGED quote price persists across steps and KEEPS its
//     (decayed) queue progress — re-pricing every tick (what the stateless quoters
//     do) instead cancels + rejoins at the back. This is why a quoter that chases
//     the mid fills far less than one that holds its price: the harness shows it.
//
// HONESTY: the truth lies BETWEEN this and fill-on-touch. This model retains queue
// priority only while the price is unchanged and attributes the whole step's taker
// volume to the top-of-book level our quote sits at (exact when we quote at best,
// an approximation when we quote deep). Aggressive volume is itself an estimate on
// snapshot-only data (the live capture signs candle volume by the mid move — the
// tick rule). Read queueFills as a realistic LOWER-ish bound; touchFills as the
// upper bound; the maker-rebate-CLOB verdict is the structural net at queueFills.

const MICROS = 1_000_000n;

interface RestingOrder {
  side: FillSide;
  priceMicros: bigint;
  sizeUnits: bigint;
  pos: QueuePosition;
  /** Mid at the most recent (re)quote — the fair value the next fill is scored against. */
  fairMidMicros: bigint;
  /** Tape ms this order's PRICE was placed (carried through holds) — the F2 dwell clock. */
  placedAtMs?: number;
}

export interface LobReplayConfig {
  /** Time-ordered L2 snapshots + per-interval taker flow. */
  tape: L2TapeStep[];
  quoter: IQuoter;
  /** Asset units quoted per side. */
  quoteSizeUnits: bigint;
  gamma: number;
  kappa: number;
  horizonBars: number;
  volWindowBars: number;
  volFloor: number;
  /** Maker fee in bps, SIGNED: negative = rebate (revenue). */
  makerFeeBps: number;
  capitalUnits: bigint;
  symbol?: string;
  riskGate?: RiskGate;
  /**
   * Perp funding rate as a SIGNED fraction per HOUR (+ ⇒ longs pay shorts, the HL
   * convention). When set, funding accrues each step on the inventory held over the
   * interval, pro-rated by the real inter-snapshot time: a held perp inventory then
   * carries its real funding flow instead of being free (MM course §8.10). Omit/0 ⇒
   * no funding (back-compat). The rate is static over the run, like staticCarry.
   */
  fundingRatePerHour?: number;
  /**
   * Quote around the book-imbalance MICRO-PRICE over this many levels per side
   * (FAIR_VALUE_AND_THESIS_DESIGN.md F1) instead of the raw mid — the adverse-
   * selection fix. The quoter centers its reservation on the micro-price; the
   * P&L attribution + drawdown + funding stay scored against the PLAIN mid (the
   * true fair value), so this honestly measures whether quoting around the
   * micro-price REDUCES adverse selection. 0/undefined ⇒ quote off the mid (legacy).
   */
  microDepth?: number;
  /**
   * F2 cross-venue fusion: a lead venue's mid (micros) per tape step (parallel to
   * `tape`; undefined where unavailable). With `leadBeta`, the quote center is pulled
   * toward the lead by β·(lead − hlMid) — a MEASURED fusion, not an assumption (HL is
   * itself a price-discovery venue; β is fit per coin and may be ≈0). Undefined ⇒ no
   * cross-venue term (unchanged).
   */
  leadMicros?: (bigint | undefined)[];
  /** F2 error-correction coefficient β (per coin). 0/undefined ⇒ ignore the lead. */
  leadBeta?: number;
  /**
   * F3 confidence-scaled spread: when true, the half-spread is scaled by current flow
   * toxicity vs its rolling average — TIGHTEN on calm/benign flow (the rebate-farming
   * regime), WIDEN on toxic one-sided flow (where adverse selection lives). Off ⇒
   * spread unchanged. The scale is clamped to [f3MinScale, f3MaxScale].
   */
  f3Toxicity?: boolean;
  f3MinScale?: number; // default 0.5 — how tight we dare quote when calm
  f3MaxScale?: number; // default 3.0 — how wide we back off when toxic
  /**
   * F2 requote hysteresis + dwell (Journal #61): hold a resting quote through sub-threshold
   * price drift instead of cancel/replacing every step — keeps the FIFO queue position.
   * Same shared decision the live engine runs (decideRequote). Omit / minBps 0 ⇒ off.
   */
  requote?: RequoteHysteresisCfg;
  /**
   * F3 warehouse loss-stop (Journal #62 sweep): when unrealised MTM on inventory breaches
   * −lossStopFrac·capital, FLATTEN at the mid (5bps taker, like MmBook.flattenAt), pull
   * quotes and stand aside for the cooldown. Mirrors the live guardrail (#55) so the stop
   * threshold can be SWEPT offline. 0/undefined ⇒ no stop (legacy).
   */
  lossStopFrac?: number;
  lossStopCooldownMs?: number;
}

export interface LobReplayMetrics {
  steps: number;
  quotingSteps: number;
  /** Honest, queue-aware fills (the real number). */
  queueFills: number;
  /** Fills a fill-on-touch model (the bar runner) would have logged — the upper bound. */
  touchFills: number;
  /** queueFills ÷ touchFills — the fraction of touches the queue actually let through. */
  fillRatio: number;
  bidFills: number;
  askFills: number;
  realisedPnlUnits: bigint;
  finalInventoryUnits: bigint;
  unrealisedPnlUnits: bigint;
  /** Funding harvested (+) or paid (−) on held inventory over the run; 0 when no rate given. */
  fundingUnits: bigint;
  netPnlUnits: bigint;
  feesUnits: bigint;
  maxDrawdownPct: number;
  /** Mean size resting ahead of our orders at placement — the queue depth we faced. */
  avgQueueAheadUnits: bigint;
  attribution: AttributionSummary;
  /** F2: steps a quote was HELD by the requote hysteresis/dwell (0 when the feature is off). */
  requoteHysteresisHolds: number;
  requoteDwellHolds: number;
  /** F3: warehouse loss-stops fired (0 when the stop is off) + the taker fees they paid. */
  lossStops: number;
  lossStopFeesUnits: bigint;
}

export class LobReplayHarness {
  run(cfg: LobReplayConfig): LobReplayMetrics {
    const symbol = cfg.symbol ?? cfg.quoter.familyId;
    const vol = new RollingVolatility(cfg.volWindowBars);
    // F1: optionally quote around the book-imbalance micro-price instead of the mid.
    const microPrice = cfg.microDepth && cfg.microDepth > 0 ? new MicroPriceCalculator({ depth: cfg.microDepth }) : undefined;
    // F3: rolling flow-toxicity for the confidence-scaled spread (shared with the live
    // fast engine via FlowToxicityScaler — one implementation, offline == live).
    const toxScaler = cfg.f3Toxicity
      ? new FlowToxicityScaler({ windowBars: cfg.volWindowBars, minScale: cfg.f3MinScale ?? 0.5, maxScale: cfg.f3MaxScale ?? 3.0 })
      : undefined;
    const book = new InventoryBook();
    const components: PnlComponent[] = [];

    let restingBid: RestingOrder | undefined;
    let restingAsk: RestingOrder | undefined;
    let quotingSteps = 0;
    let queueFills = 0;
    let touchFills = 0;
    let bidFills = 0;
    let askFills = 0;
    let aheadSum = 0n;
    let placements = 0;
    let hysteresisHolds = 0;
    let dwellHolds = 0;
    let lossStops = 0;
    let lossStopFees = 0n;
    let standAsideUntilMs = 0;

    // Funding accrual on held inventory (MM course §8.10). Static rate per hour,
    // pro-rated by the real inter-snapshot interval; signed into equity + net.
    let fundingUnits = 0n;
    const fundingRatePerHour = cfg.fundingRatePerHour ?? 0;
    let prevTsMs: number | undefined;
    let prevMid: bigint | undefined;

    let peakEquity = cfg.capitalUnits;
    let maxDrawdownPct = 0;

    const markDd = (m: bigint): void => {
      const equity = book.equityUnits(cfg.capitalUnits, m) + fundingUnits;
      if (equity > peakEquity) peakEquity = equity;
      if (peakEquity > 0n) {
        const dd = (Number(peakEquity - equity) / Number(peakEquity)) * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    };

    const feeFor = (notionalUnits: bigint): bigint =>
      (notionalUnits * BigInt(Math.round(cfg.makerFeeBps * 100))) / 1_000_000n;

    const applyFill = (side: FillSide, priceMicros: bigint, qty: bigint, fairMid: bigint, markoutMid: bigint): void => {
      const notional = (qty * priceMicros) / MICROS;
      const fee = feeFor(notional);
      const invBefore = book.inventoryUnits();
      book.apply({ side, sizeUnits: qty, priceMicros, feeUnits: fee });
      components.push(attributeFill({ side, sizeUnits: qty, priceMicros, feeUnits: fee }, fairMid, markoutMid, invBefore));
    };

    for (let i = 0; i < cfg.tape.length; i++) {
      const step = cfg.tape[i];
      const ob = step.book;
      const mid = midMicros(ob);
      if (mid === undefined) continue; // empty book — nothing to mark or quote against
      vol.push(Number(mid) / 1e6);

      // --- 0) accrue funding on the inventory CARRIED INTO this step over the
      //         interval since the previous snapshot. A long pays funding when the
      //         rate is positive ⇒ fundingPnl = −(signed inventory notional)·rate·dt.
      const tsMs = ob.ts.getTime();
      if (fundingRatePerHour !== 0 && prevTsMs !== undefined && prevMid !== undefined) {
        const dtHours = (tsMs - prevTsMs) / 3_600_000;
        const inv = book.inventoryUnits();
        if (dtHours > 0 && inv !== 0n) {
          const notional = (inv * prevMid) / MICROS; // signed USDC-units held over [prev, now]
          fundingUnits += BigInt(Math.round(-Number(notional) * fundingRatePerHour * dtHours));
        }
      }
      prevTsMs = tsMs;
      prevMid = mid;

      // --- 1) settle orders resting since the previous step against THIS flow ---
      // The single-side FIFO fill rule is the SHARED `settleRestingOrder` (queue-fill.ts),
      // so the offline replay and the live engine (live/l2-live-fill-engine.ts) cannot
      // drift. The harness keeps the fairMid wrapper; the mechanics live in one place.
      const flow = {
        aggressiveBuyUnits: step.aggressiveBuyUnits,
        aggressiveSellUnits: step.aggressiveSellUnits,
        tradedHighMicros: step.tradedHighMicros,
        tradedLowMicros: step.tradedLowMicros,
      };
      if (restingBid) {
        const fairMid = restingBid.fairMidMicros;
        const out = settleRestingOrder(restingBid, ob, flow);
        if (out.touched) touchFills += 1;
        if (out.filledUnits > 0n) {
          applyFill('BUY', restingBid.priceMicros, out.filledUnits, fairMid, mid);
          queueFills += 1;
          bidFills += 1;
        }
        restingBid = out.remaining ? { ...out.remaining, fairMidMicros: fairMid } : undefined;
      }
      if (restingAsk) {
        const fairMid = restingAsk.fairMidMicros;
        const out = settleRestingOrder(restingAsk, ob, flow);
        if (out.touched) touchFills += 1;
        if (out.filledUnits > 0n) {
          applyFill('SELL', restingAsk.priceMicros, out.filledUnits, fairMid, mid);
          queueFills += 1;
          askFills += 1;
        }
        restingAsk = out.remaining ? { ...out.remaining, fairMidMicros: fairMid } : undefined;
      }

      if (!vol.ready()) continue; // warmup: don't quote yet

      // --- 1b) F3 warehouse loss-stop (mirrors MmBook.guardrail, Journal #55/#62): flatten at
      //         the mid (5bps taker), pull quotes, stand aside through the cooldown.
      if (tsMs < standAsideUntilMs) {
        restingBid = undefined;
        restingAsk = undefined;
        markDd(mid);
        continue;
      }
      if (cfg.lossStopFrac && cfg.lossStopFrac > 0 && book.inventoryUnits() !== 0n) {
        const stopUnits = BigInt(Math.round(cfg.lossStopFrac * Number(cfg.capitalUnits)));
        if (book.unrealisedUnits(mid) < -stopUnits) {
          const inv = book.inventoryUnits();
          const side: FillSide = inv > 0n ? 'SELL' : 'BUY';
          const size = inv > 0n ? inv : -inv;
          const fee = (((size * mid) / MICROS) * 5n) / 10_000n; // taker 5bps, not the rebate
          book.apply({ side, sizeUnits: size, priceMicros: mid, feeUnits: fee });
          lossStops += 1;
          lossStopFees += fee;
          standAsideUntilMs = tsMs + (cfg.lossStopCooldownMs ?? 900_000);
          restingBid = undefined;
          restingAsk = undefined;
          markDd(mid);
          continue;
        }
      }

      // --- 2) re-quote off this book ---
      const inventoryBefore = book.inventoryUnits();
      // The quote center: the micro-price when enabled (so we quote where price is
      // GOING), else the mid; then F2 pulls it toward the lead venue by β·(lead−mid).
      // Attribution below still uses the plain `mid`.
      const microMicros = microPrice ? microPrice.compute(ob) : undefined;
      let referenceMicros: bigint | undefined = microMicros !== undefined ? BigInt(Math.round(microMicros)) : undefined;
      const lead = cfg.leadMicros?.[i];
      if (lead !== undefined && cfg.leadBeta) {
        referenceMicros = crossVenueReference(referenceMicros ?? mid, mid, lead, cfg.leadBeta);
      }
      // F3: spread scale from current flow toxicity vs its rolling average (shared scaler).
      const spreadScale = toxScaler?.scale(step.aggressiveBuyUnits, step.aggressiveSellUnits);
      const ctx: QuoteContext = {
        inventoryUnits: inventoryBefore,
        midMicros: mid,
        referenceMicros,
        spreadScale,
        nowMs: step.book.ts.getTime(),
        volatility: vol.valueOr(cfg.volFloor),
        riskAversion: cfg.gamma,
        arrivalDecay: cfg.kappa,
        horizonBars: cfg.horizonBars,
        schemaVersion: 1,
      };
      const quote = cfg.quoter.quote(ctx, symbol);

      if (cfg.riskGate) {
        const navRatio = Number(book.equityUnits(cfg.capitalUnits, mid)) / Number(cfg.capitalUnits);
        const state: RiskState = { inventoryUnits: inventoryBefore, navRatio, vpin: 0, recentAdverseUnits: 0n, killed: false };
        if (cfg.riskGate.check(quote, state).kind !== 'Allow') {
          restingBid = undefined; // pull quotes on Deny/Pause
          restingAsk = undefined;
          markDd(mid);
          continue;
        }
      }
      quotingSteps += 1;

      const onPlacement = (aheadUnits: bigint): void => {
        placements += 1;
        aheadSum += aheadUnits;
      };
      // F2: the shared requote hysteresis/dwell decision (same call the live engine makes) may
      // hold the resting price through sub-threshold drift — keeping the FIFO queue position.
      const decBid = decideRequote(restingBid, quote.bid.priceMicros, mid, restingBid?.placedAtMs, ob.ts.getTime(), cfg.requote);
      const decAsk = decideRequote(restingAsk, quote.ask.priceMicros, mid, restingAsk?.placedAtMs, ob.ts.getTime(), cfg.requote);
      if (decBid.held === 'hysteresis') hysteresisHolds += 1;
      else if (decBid.held === 'dwell') dwellHolds += 1;
      if (decAsk.held === 'hysteresis') hysteresisHolds += 1;
      else if (decAsk.held === 'dwell') dwellHolds += 1;
      // F3: the quoter may CUT a side's size (concentration ramp; 0 = reduce-only, side pulled).
      restingBid = quote.bid.sizeUnits > 0n ? this.place(restingBid, 'BUY', decBid.priceMicros, quote.bid.sizeUnits, ob, mid, onPlacement) : undefined;
      restingAsk = quote.ask.sizeUnits > 0n ? this.place(restingAsk, 'SELL', decAsk.priceMicros, quote.ask.sizeUnits, ob, mid, onPlacement) : undefined;

      // --- 3) mark drawdown on the structural equity at this mid ---
      markDd(mid);
    }

    const lastBook = lastNonEmpty(cfg.tape);
    const lastMid = lastBook ? midMicros(lastBook) ?? MICROS : MICROS;
    const finalInventory = book.inventoryUnits();
    const unrealised = book.unrealisedUnits(lastMid);

    return {
      steps: cfg.tape.length,
      quotingSteps,
      queueFills,
      touchFills,
      fillRatio: touchFills > 0 ? queueFills / touchFills : queueFills > 0 ? 1 : 0,
      bidFills,
      askFills,
      realisedPnlUnits: book.realisedUnits(),
      finalInventoryUnits: finalInventory,
      unrealisedPnlUnits: unrealised,
      fundingUnits,
      netPnlUnits: book.totalPnlUnits(lastMid) + fundingUnits,
      feesUnits: book.feesUnits(),
      maxDrawdownPct,
      avgQueueAheadUnits: placements > 0 ? aheadSum / BigInt(placements) : 0n,
      attribution: sumComponents(components),
      requoteHysteresisHolds: hysteresisHolds,
      requoteDwellHolds: dwellHolds,
      lossStops,
      lossStopFeesUnits: lossStopFees,
    };
  }

  /** Place or persist a resting order. Same price ⇒ keep queue progress; new price ⇒ rejoin at back.
   *  Delegates the post-only + queue-join mechanics to the SHARED `placeRestingOrder` (queue-fill.ts)
   *  so the harness and the live engine place identically; the harness just adds the fairMid stamp. */
  private place(
    current: RestingOrder | undefined,
    side: FillSide,
    priceMicros: bigint,
    sizeUnits: bigint,
    ob: OrderBook,
    mid: bigint,
    onNewPlacement: (aheadUnits: bigint) => void,
  ): RestingOrder | undefined {
    const res = placeRestingOrder(current as RestingQuote | undefined, side, priceMicros, sizeUnits, ob);
    if (!res.order) return undefined; // post-only rejected
    if (res.aheadUnitsAtPlacement !== undefined) onNewPlacement(res.aheadUnitsAtPlacement);
    // Same price held ⇒ keep queue progress + the dwell clock, refresh fair mid; new price ⇒
    // fresh order, fair mid and dwell clock restarted (F2).
    const held = current && current.priceMicros === res.order.priceMicros;
    return { ...res.order, fairMidMicros: mid, placedAtMs: held ? current!.placedAtMs : ob.ts.getTime() };
  }
}

function lastNonEmpty(tape: L2TapeStep[]): OrderBook | undefined {
  for (let i = tape.length - 1; i >= 0; i--) {
    if (midMicros(tape[i].book) !== undefined) return tape[i].book;
  }
  return undefined;
}
