import { ITradingVenue, Side } from '../../stat-arb/trading-venue.interface';
import { BookDelta, BetaMapEntry, HedgeConfig, HedgeOrder, computeHedge, netDeltaByUnderlying, hedgeOrderUnits } from './desk-delta-hedger';
import { HedgeQualityTracker, HedgeQualitySnapshot } from './hedge-quality';

// DeskHedgeController — the EXECUTING side of the delta hedge (HEDGING_MODEL.md §1–2).
//
// `computeHedge` is the pure model (what to trade); this controller actually FILLS those orders
// on an injected ITradingVenue (a PaperVenue fed by the HL perp mid in paper; a real adapter only
// if/when the live posture is ever armed — out of scope). It holds the perp position per hedge
// underlying, marks it to the live price, accrues funding (a short hedge EARNS on positive funding),
// and reports the desk's gross delta, post-hedge residual, and hedge P&L for the snapshot.
//
// Accounting is plain mark-to-market in USD: a fill of `signedUnits` at `fillPrice` moves
// cash by −signedUnits·fillPrice (buying spends, selling receives); P&L = cash + units·mark
// − fees + funding. No floats cross the venue boundary — units/notional are BigInt micro-units.

const MICROS = 1_000_000;

interface PerpPosition {
  units: bigint; // signed 6-dec perp units (long > 0, short < 0)
  cashUsd: number; // cumulative cash from fills (sell +, buy −)
  feesUsd: number; // cumulative taker + half-spread paid
  fundingUsd: number; // cumulative funding (short earns on positive rate)
}

export interface HedgeUnderlyingSnap {
  underlying: string;
  netDeltaUsd: number; // beta-weighted book delta we're hedging
  hedgeUnits: number; // signed perp units held (coins)
  hedgeNotionalUsd: number; // hedge mark value
  residualUsd: number; // net + hedge — what price still runs over
  /** Mark used to value this leg, USD/coin (F0: persisted to mm_hedge_nav). */
  markUsd: number;
  /** This leg's P&L = mtm + funding − fees (F0: the per-leg read the leak table previously
   *  had to imply as desk-net − books-sum). */
  pnlUsd: number;
  fundingUsd: number;
  feesUsd: number;
}

export interface HedgeSnapshot {
  enabled: boolean;
  grossDeltaUsd: number; // Σ|net delta| before hedging — the size of the bet
  residualUsd: number; // Σ|residual| after hedging — what we still carry
  hedgePnlUsd: number; // mark-to-market + funding − fees
  hedgeCostUsd: number; // cumulative taker + spread paid
  fundingUsd: number; // cumulative funding carry (+ = received)
  perUnderlying: HedgeUnderlyingSnap[];
  /** Orders actually EXECUTED last tick (post anti-churn filtering, F1). */
  ordersLastTick: HedgeOrder[];
  /** F1 anti-churn decisions from the last tick (suppressions + flow flips), rate-bounded.
   *  Optional so existing test fixtures need not build it. */
  decisionsLastTick?: HedgeDecision[];
  /** The §0 KPI (residual_mm_risk_study.md): factor-vs-basis residual variance + live β/R² per
   *  book. Residual DELTA can read ~0 while most of an alt's vol is still live on the desk —
   *  this block is the honest hedge-quality read. Optional so test fixtures need not build it. */
  quality?: HedgeQualitySnapshot;
}

export interface RebalanceCtx {
  /** underlying → live mid (micro-USD/coin); marks the hedge and accrues funding. */
  prices: Record<string, bigint>;
  /** underlying → funding rate per hour (fraction); short hedge earns when > 0. */
  fundingRatePerHour?: Record<string, number>;
  /** Hours since the last rebalance, for funding accrual. */
  dtHours?: number;
  /** Book symbols whose PRIMARY inventory flattened since the last hedge tick (incl. loss-stops).
   *  F1 net-first: never emit an opposing hedge leg in the same cycle as a primary flatten — the
   *  band + min-hold absorb the recomputed net delta instead (run55: stop → unwind → re-open). */
  flattenedBooks?: string[];
}

/** One F1 anti-churn decision — a suppressed order or a state change, WITH its numbers (the
 *  PART V observability requirement: the run must be auditable without a debugger). The trader
 *  turns each into a `BLOCKED ▸` / `FLOW ▸` log line + tape event. Continuous conditions
 *  (band-hold, min-hold) are rate-bounded to one emission per leg per rule per minute. */
export interface HedgeDecision {
  underlying: string;
  rule: 'band-hold' | 'min-hold' | 'flip-cooldown' | 'flow-freeze' | 'net-first' | 'basis-gate' | 'flow-flip';
  /** Pre-formatted trigger numbers (net delta vs band, ms since last fire, flow, …). */
  detail: string;
  /** |notional| of the order this decision suppressed (0 for pure state changes like flow-flip). */
  suppressedNotionalUsd: number;
}

export class DeskHedgeController {
  private readonly pos = new Map<string, PerpPosition>();
  private lastOrders: HedgeOrder[] = [];
  /** F1 anti-churn state, all keyed per hedge underlying (legs are independent). */
  private readonly lastFireMs = new Map<string, number>(); // last EXECUTED order per leg (min-hold)
  private readonly lastFlipMs = new Map<string, number>(); // last executed direction flip (flip cooldown)
  private readonly addFreezeUntilMs = new Map<string, number>(); // adds frozen after a book flow sign-flip
  private readonly lastFlowSign = new Map<string, number>(); // per BOOK symbol: last signed flow (±1, 0=neutral)
  /** Rate-bound for continuous decisions: (underlying|rule) → last emit ms. */
  private readonly lastDecisionMs = new Map<string, number>();
  private decisionsLast: HedgeDecision[] = [];
  private static readonly DECISION_RATE_MS = 60_000;
  /** Residual-variance KPI (study §0); fed once per rebalance with the same books + marks. */
  private quality: HedgeQualityTracker;
  /** Last live mark seen per underlying. A book going un-warm / mid-relaunch drops its symbol from
   *  the desk price map (deskDeltas skips mid≤0); marking an OPEN hedge at the resulting 0 produced a
   *  phantom P&L blow-up AND made computeHedge think it held nothing ⇒ it re-traded every 100ms tick
   *  (Journal #45 bug: +$194M hedge P&L). We fall back to this last-known mark so the hedge stays
   *  correctly valued + converged across the price flicker. */
  private readonly lastMark = new Map<string, bigint>();

  /** Throttle for resolveMid fetches per underlying (a hedge underlying with NO book — ETH once the
   *  ETH book was dropped from the Sweet-16 set — must be re-marked from the venue, but rebalance
   *  runs every fast cycle and must not hammer the REST endpoint). */
  private readonly lastMidFetchMs = new Map<string, number>();

  constructor(
    private readonly venue: ITradingVenue,
    private readonly cfg: HedgeConfig,
    private readonly clock: () => Date = () => new Date(),
    // Optional price sink: push the current marks to the venue's price source before filling
    // so the paper taker fills at the same mid we hedge against (the live module wires this to
    // the PaperVenue's pricePoller). Omit ⇒ the venue prices itself (the unit tests).
    private readonly syncPrices?: (prices: Record<string, bigint>) => void,
    // Optional venue mid lookup for hedge underlyings with NO quoted book. Book mids reach us via
    // ctx.prices; an underlying that is only a hedge leg (ETH/BTC after the Sweet-16 swap) never
    // appears there, and without this resolver its orders are silently skipped at the
    // missing-mark guard below — the desk then carries its full net delta unhedged.
    private readonly resolveMid?: (underlying: string) => Promise<bigint | null>,
    private readonly midRefreshMs: number = 1_000,
  ) {
    this.quality = new HedgeQualityTracker(cfg.betaMap, undefined, cfg.qualityBucketMs);
  }

  /** The beta-map entry for a book symbol, or undefined. For COVERAGE reporting (Journal #55b):
   *  undefined or β=0 both mean this book runs NAKED — the snapshot/UI must say so explicitly. */
  betaFor(symbol: string): BetaMapEntry | undefined {
    return this.cfg.betaMap[symbol];
  }

  /** Hedge underlyings the supplied books map onto (betaMap, self-hedge default, beta-0 skipped)
   *  plus every leg we already hold — the set that must have a usable mark this tick. */
  private neededUnderlyings(books: BookDelta[]): Set<string> {
    const needed = new Set<string>(this.pos.keys());
    for (const b of books) {
      const m = this.cfg.betaMap[b.symbol] ?? { underlying: b.symbol, beta: 1 };
      if (m.beta !== 0) needed.add(m.underlying);
    }
    return needed;
  }

  /** Refresh lastMark from the venue (throttled) for any needed underlying without a live book mid. */
  private async refreshBooklessMarks(books: BookDelta[], prices: Record<string, bigint>): Promise<void> {
    if (!this.resolveMid) return;
    for (const u of this.neededUnderlyings(books)) {
      const live = prices[u];
      if (live && live > 0n) continue; // a book supplies this mark
      const nowMs = this.clock().getTime();
      const last = this.lastMidFetchMs.get(u) ?? 0;
      if (nowMs - last < this.midRefreshMs && this.lastMark.has(u)) continue; // throttled; lastMark carries
      this.lastMidFetchMs.set(u, nowMs);
      try {
        const mid = await this.resolveMid(u);
        if (mid && mid > 0n) this.lastMark.set(u, mid);
      } catch {
        /* keep the previous lastMark; a failed fetch must never sink the hedge tick */
      }
    }
  }

  private posOf(u: string): PerpPosition {
    let p = this.pos.get(u);
    if (!p) {
      p = { units: 0n, cashUsd: 0, feesUsd: 0, fundingUsd: 0 };
      this.pos.set(u, p);
    }
    return p;
  }

  /**
   * Drop the entire hedge book to flat — clear every perp position, the last orders, and the
   * last-known marks, so a fresh snapshot() reads zero gross/residual/P&L (perUnderlying empty).
   * The desk's `closeAll` (the "come up clean" shutdown ritual, scripts/stop-desk.sh) calls this so
   * the UI returns to a true flat 000 WITHOUT a process restart. (Journal #45a: the in-memory hedge
   * state is otherwise only cleared by killing the process — the exact ghost-P&L trap, where a held
   * perp marked against a stale price keeps showing a phantom P&L after the books are flat.)
   * Returns the number of perp legs that were tracked, for the desk tape.
   */
  reset(): number {
    const legs = this.pos.size;
    this.pos.clear();
    this.lastOrders = [];
    this.lastMark.clear();
    this.lastFireMs.clear();
    this.lastFlipMs.clear();
    this.addFreezeUntilMs.clear();
    this.lastFlowSign.clear();
    this.lastDecisionMs.clear();
    this.decisionsLast = [];
    this.quality = new HedgeQualityTracker(this.cfg.betaMap, undefined, this.cfg.qualityBucketMs);
    return legs;
  }

  /**
   * Resolve a usable mark per underlying: prefer the live price, fall back to the last seen one for
   * any underlying whose live price is missing/zero (a book going un-warm drops out of the desk price
   * map). Ingests the live prices into the last-known cache. EVERYTHING downstream (funding, current
   * hedge, fill price, P&L mark) uses the result, so the hedge is valued + sized off ONE consistent
   * price set and never sees a phantom 0. Includes every underlying we hold or have ever marked, so a
   * held position is always valued even on a tick where its book is silent.
   */
  private resolveMarks(prices: Record<string, bigint>): Record<string, bigint> {
    for (const [u, p] of Object.entries(prices)) if (p && p > 0n) this.lastMark.set(u, p);
    const out: Record<string, bigint> = {};
    for (const u of new Set<string>([...Object.keys(prices), ...this.pos.keys(), ...this.lastMark.keys()])) {
      const live = prices[u];
      out[u] = live && live > 0n ? live : this.lastMark.get(u) ?? 0n;
    }
    return out;
  }

  /** Signed hedge notional (USD) per underlying at the supplied marks. */
  private hedgeNotionalUsd(prices: Record<string, bigint>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [u, p] of this.pos) out[u] = (Number(p.units) / MICROS) * (Number(prices[u] ?? 0n) / MICROS);
    return out;
  }

  /**
   * One hedge tick: accrue funding on the held hedge, compute the banded rebalance against the
   * current hedge notional, fill the orders on the venue, and return the post-hedge snapshot.
   */
  async rebalance(books: BookDelta[], ctx: RebalanceCtx): Promise<HedgeSnapshot> {
    // Resolve marks ONCE (live price, else last-known) and use them for every step below — funding,
    // current hedge, fill price, and the returned snapshot — so a book's price flicker can't make the
    // hedge mis-value, churn, or blow up its P&L (Journal #45).
    await this.refreshBooklessMarks(books, ctx.prices); // mark hedge-only underlyings (no book ⇒ no ctx price)
    const marks = this.resolveMarks(ctx.prices);

    // 0. The hedge-quality KPI samples the same books + marks the hedge itself trades off.
    this.quality.update(books, marks, this.clock().getTime());

    // 1. Funding on what we already hold (short hedge earns when the rate is positive).
    const dt = ctx.dtHours ?? 0;
    if (dt > 0 && ctx.fundingRatePerHour) {
      for (const [u, p] of this.pos) {
        const notional = (Number(p.units) / MICROS) * (Number(marks[u] ?? 0n) / MICROS);
        p.fundingUsd += -notional * (ctx.fundingRatePerHour[u] ?? 0) * dt; // long pays, short receives
      }
    }

    // 2. F1 anti-churn (Journal #60). Decisions are collected per tick; the trader renders each
    //    as a BLOCKED ▸ / FLOW ▸ line + tape event (PART V observability).
    const now = this.clock().getTime();
    this.decisionsLast = [];

    // 2a. Flow sign tracking per book: a sign-flip (|flow| ≥ threshold, opposite to the last
    //     signed read) freezes hedge ADDS on the book's underlying — the front of the move is
    //     reversing; hedging now risks buying the top of the hedge leg (§5).
    const flowTheta = this.cfg.flowFreezeThreshold ?? 0.25;
    const cooldown = this.cfg.flipCooldownMs ?? 0;
    for (const b of books) {
      if (b.flow === undefined) continue;
      const sign = b.flow >= flowTheta ? 1 : b.flow <= -flowTheta ? -1 : 0;
      const prev = this.lastFlowSign.get(b.symbol) ?? 0;
      if (sign !== 0 && prev !== 0 && sign !== prev && cooldown > 0) {
        const u = (this.cfg.betaMap[b.symbol] ?? { underlying: b.symbol, beta: 1 }).underlying;
        this.addFreezeUntilMs.set(u, now + cooldown);
        this.decide(now, {
          underlying: u,
          rule: 'flow-flip',
          detail: `${b.symbol} flow ${prev > 0 ? '+' : '−'}→${sign > 0 ? '+' : '−'} (${b.flow.toFixed(2)}) — ${u} adds frozen ${Math.round(cooldown / 1000)}s`,
          suppressedNotionalUsd: 0,
        }, true);
      }
      if (sign !== 0) this.lastFlowSign.set(b.symbol, sign);
    }

    // 2b. Basis gate: 'flatten'-policy books are excluded from the hedge PLAN (their basis makes
    //     the cross-hedge a second bet — the book's own stops/skew bound them). They stay in the
    //     snapshot + quality KPI, so the carried delta is reported, never hidden.
    const policy = this.cfg.basisPolicy ?? {};
    const plannedBooks = books.filter((b) => policy[b.symbol] !== 'flatten');
    for (const b of books) {
      if (policy[b.symbol] !== 'flatten') continue;
      const deltaUsd = (Number(b.inventoryUnits) / MICROS) * (Number(marks[b.symbol] ?? b.midMicros) / MICROS);
      if (Math.abs(deltaUsd) > this.cfg.bandUsd) {
        this.decide(now, {
          underlying: b.symbol,
          rule: 'basis-gate',
          detail: `${b.symbol} $${Math.round(deltaUsd)} delta carried UNHEDGED (basis policy: flatten-primary; band $${this.cfg.bandUsd})`,
          suppressedNotionalUsd: Math.abs(deltaUsd),
        });
      }
    }

    // 2c. Net-first: a primary flatten this cycle (incl. loss-stops) must not trigger an opposing
    //     hedge leg in the same cycle — the band + min-hold absorb the recomputed delta instead.
    const flattenedUnderlyings = new Set<string>(
      (ctx.flattenedBooks ?? []).map((s) => (this.cfg.betaMap[s] ?? { underlying: s, beta: 1 }).underlying),
    );

    // 2d. The banded rebalance plan, then the per-order suppression chain.
    const plan = computeHedge(plannedBooks, this.hedgeNotionalUsd(marks), this.cfg);
    const minHold = this.cfg.minHoldMs ?? 0;
    const orders: HedgeOrder[] = [];
    for (const o of plan.orders) {
      const u = o.underlying;
      const resid = plan.states.find((s) => s.underlying === u)?.residualUsd ?? 0;
      // Per-underlying band override (wider than the global band only).
      const band = Math.max(this.cfg.bandUsd, this.cfg.bandUsdByUnderlying?.[u] ?? 0);
      if (Math.abs(resid) <= band) {
        this.decide(now, { underlying: u, rule: 'band-hold', detail: `|residual $${Math.round(resid)}| ≤ band $${band} — holding`, suppressedNotionalUsd: o.notionalUsd });
        continue;
      }
      if (flattenedUnderlyings.has(u)) {
        // Start the min-hold clock so the unwind also can't fire on the very next cycle.
        this.lastFireMs.set(u, now);
        this.decide(now, { underlying: u, rule: 'net-first', detail: `primary flatten this cycle — ${o.reason} $${Math.round(o.notionalUsd)} absorbed (residual $${Math.round(resid)})`, suppressedNotionalUsd: o.notionalUsd }, true);
        continue;
      }
      const sinceFire = now - (this.lastFireMs.get(u) ?? -Infinity);
      if (minHold > 0 && sinceFire < minHold) {
        this.decide(now, { underlying: u, rule: 'min-hold', detail: `last fire ${Math.round(sinceFire / 1000)}s ago < ${Math.round(minHold / 1000)}s — ${o.reason} $${Math.round(o.notionalUsd)} held`, suppressedNotionalUsd: o.notionalUsd });
        continue;
      }
      if (o.reason === 'flip' && cooldown > 0 && now - (this.lastFlipMs.get(u) ?? -Infinity) < cooldown) {
        this.decide(now, { underlying: u, rule: 'flip-cooldown', detail: `flip ${Math.round((now - this.lastFlipMs.get(u)!) / 1000)}s after last flip < ${Math.round(cooldown / 1000)}s — $${Math.round(o.notionalUsd)} held`, suppressedNotionalUsd: o.notionalUsd }, true);
        continue;
      }
      if ((o.reason === 'open' || o.reason === 'increase' || o.reason === 'flip') && now < (this.addFreezeUntilMs.get(u) ?? 0)) {
        this.decide(now, { underlying: u, rule: 'flow-freeze', detail: `adds frozen ${Math.round(((this.addFreezeUntilMs.get(u) ?? 0) - now) / 1000)}s more (flow flip) — ${o.reason} $${Math.round(o.notionalUsd)} held`, suppressedNotionalUsd: o.notionalUsd });
        continue;
      }
      orders.push(o);
    }
    this.lastOrders = orders;
    if (orders.length) this.syncPrices?.(marks); // pin the venue's fill price to our marks

    // 3. Fill each surviving order as a taker on the venue; update the position from the real fill.
    for (const o of orders) {
      const priceMicros = marks[o.underlying];
      if (!priceMicros || priceMicros <= 0n) continue;
      const units = hedgeOrderUnits(o.notionalUsd, priceMicros);
      if (units <= 0n) continue;
      const side: Side = o.side === 'buy' ? 'BUY' : 'SELL';
      const fill = await this.venue.placeOrder({
        symbol: o.underlying,
        side,
        notionalUnits: BigInt(Math.round(o.notionalUsd * MICROS)), // USD micro-notional (fee basis)
        idempotencyKey: `hedge-${o.underlying}-${this.clock().getTime()}-${units}`,
      });
      const p = this.posOf(o.underlying);
      const signed = side === 'BUY' ? units : -units;
      const fillPrice = Number(fill.priceMicros) / MICROS;
      p.units += signed;
      p.cashUsd -= (Number(signed) / MICROS) * fillPrice;
      p.feesUsd += Number(fill.feesUnits) / MICROS;
      this.lastFireMs.set(o.underlying, now);
      if (o.reason === 'flip') this.lastFlipMs.set(o.underlying, now);
    }

    return this.snapshot(books, ctx.prices);
  }

  /** Record an F1 decision, rate-bounded per (underlying, rule) unless `discrete` (a state
   *  change like a flow flip or an executed-path event — those always emit). */
  private decide(now: number, d: HedgeDecision, discrete = false): void {
    const key = `${d.underlying}|${d.rule}`;
    if (!discrete && now - (this.lastDecisionMs.get(key) ?? -Infinity) < DeskHedgeController.DECISION_RATE_MS) return;
    this.lastDecisionMs.set(key, now);
    this.decisionsLast.push(d);
  }

  /** Desk gross delta, post-hedge residual, and hedge P&L at the supplied marks. Resolves missing
   *  marks to the last-known price so an open hedge is never valued at 0 (Journal #45). */
  snapshot(books: BookDelta[], prices: Record<string, bigint>): HedgeSnapshot {
    const marks = this.resolveMarks(prices);
    const net = netDeltaByUnderlying(books, this.cfg.betaMap);
    const hedgeNotional = this.hedgeNotionalUsd(marks);
    const underlyings = new Set<string>([...Object.keys(net), ...this.pos.keys()]);
    let grossDeltaUsd = 0;
    let residualUsd = 0;
    let hedgePnlUsd = 0;
    let hedgeCostUsd = 0;
    let fundingUsd = 0;
    const perUnderlying: HedgeUnderlyingSnap[] = [];

    for (const u of [...underlyings].sort()) {
      const netDeltaUsd = net[u] ?? 0;
      const hn = hedgeNotional[u] ?? 0;
      const resid = netDeltaUsd + hn;
      const p = this.pos.get(u);
      const markUsd = Number(marks[u] ?? 0n) / MICROS;
      const mtm = p ? p.cashUsd + (Number(p.units) / MICROS) * markUsd : 0;
      const legPnl = mtm + (p?.fundingUsd ?? 0) - (p?.feesUsd ?? 0);
      grossDeltaUsd += Math.abs(netDeltaUsd);
      residualUsd += Math.abs(resid);
      hedgePnlUsd += legPnl;
      hedgeCostUsd += p?.feesUsd ?? 0;
      fundingUsd += p?.fundingUsd ?? 0;
      perUnderlying.push({
        underlying: u,
        netDeltaUsd,
        hedgeUnits: p ? Number(p.units) / MICROS : 0,
        hedgeNotionalUsd: hn,
        residualUsd: resid,
        markUsd,
        pnlUsd: legPnl,
        fundingUsd: p?.fundingUsd ?? 0,
        feesUsd: p?.feesUsd ?? 0,
      });
    }

    return { enabled: true, grossDeltaUsd, residualUsd, hedgePnlUsd, hedgeCostUsd, fundingUsd, perUnderlying, ordersLastTick: this.lastOrders, decisionsLastTick: this.decisionsLast, quality: this.quality.snapshot() };
  }
}
