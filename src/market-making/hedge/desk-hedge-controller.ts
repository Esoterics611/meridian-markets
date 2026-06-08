import { ITradingVenue, Side } from '../../stat-arb/trading-venue.interface';
import { BookDelta, HedgeConfig, HedgeOrder, computeHedge, netDeltaByUnderlying, hedgeOrderUnits } from './desk-delta-hedger';

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
}

export interface HedgeSnapshot {
  enabled: boolean;
  grossDeltaUsd: number; // Σ|net delta| before hedging — the size of the bet
  residualUsd: number; // Σ|residual| after hedging — what we still carry
  hedgePnlUsd: number; // mark-to-market + funding − fees
  hedgeCostUsd: number; // cumulative taker + spread paid
  fundingUsd: number; // cumulative funding carry (+ = received)
  perUnderlying: HedgeUnderlyingSnap[];
  ordersLastTick: HedgeOrder[];
}

export interface RebalanceCtx {
  /** underlying → live mid (micro-USD/coin); marks the hedge and accrues funding. */
  prices: Record<string, bigint>;
  /** underlying → funding rate per hour (fraction); short hedge earns when > 0. */
  fundingRatePerHour?: Record<string, number>;
  /** Hours since the last rebalance, for funding accrual. */
  dtHours?: number;
}

export class DeskHedgeController {
  private readonly pos = new Map<string, PerpPosition>();
  private lastOrders: HedgeOrder[] = [];

  constructor(
    private readonly venue: ITradingVenue,
    private readonly cfg: HedgeConfig,
    private readonly clock: () => Date = () => new Date(),
    // Optional price sink: push the current marks to the venue's price source before filling
    // so the paper taker fills at the same mid we hedge against (the live module wires this to
    // the PaperVenue's pricePoller). Omit ⇒ the venue prices itself (the unit tests).
    private readonly syncPrices?: (prices: Record<string, bigint>) => void,
  ) {}

  private posOf(u: string): PerpPosition {
    let p = this.pos.get(u);
    if (!p) {
      p = { units: 0n, cashUsd: 0, feesUsd: 0, fundingUsd: 0 };
      this.pos.set(u, p);
    }
    return p;
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
    // 1. Funding on what we already hold (short hedge earns when the rate is positive).
    const dt = ctx.dtHours ?? 0;
    if (dt > 0 && ctx.fundingRatePerHour) {
      for (const [u, p] of this.pos) {
        const notional = (Number(p.units) / MICROS) * (Number(ctx.prices[u] ?? 0n) / MICROS);
        p.fundingUsd += -notional * (ctx.fundingRatePerHour[u] ?? 0) * dt; // long pays, short receives
      }
    }

    // 2. The banded rebalance against the current hedge notional.
    const plan = computeHedge(books, this.hedgeNotionalUsd(ctx.prices), this.cfg);
    this.lastOrders = plan.orders;
    if (plan.orders.length) this.syncPrices?.(ctx.prices); // pin the venue's fill price to our marks

    // 3. Fill each order as a taker on the venue; update the perp position from the real fill.
    for (const o of plan.orders) {
      const priceMicros = ctx.prices[o.underlying];
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
    }

    return this.snapshot(books, ctx.prices);
  }

  /** Desk gross delta, post-hedge residual, and hedge P&L at the supplied marks. */
  snapshot(books: BookDelta[], prices: Record<string, bigint>): HedgeSnapshot {
    const net = netDeltaByUnderlying(books, this.cfg.betaMap);
    const hedgeNotional = this.hedgeNotionalUsd(prices);
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
      const mtm = p ? p.cashUsd + (Number(p.units) / MICROS) * (Number(prices[u] ?? 0n) / MICROS) : 0;
      grossDeltaUsd += Math.abs(netDeltaUsd);
      residualUsd += Math.abs(resid);
      hedgePnlUsd += mtm + (p?.fundingUsd ?? 0) - (p?.feesUsd ?? 0);
      hedgeCostUsd += p?.feesUsd ?? 0;
      fundingUsd += p?.fundingUsd ?? 0;
      perUnderlying.push({ underlying: u, netDeltaUsd, hedgeUnits: p ? Number(p.units) / MICROS : 0, hedgeNotionalUsd: hn, residualUsd: resid });
    }

    return { enabled: true, grossDeltaUsd, residualUsd, hedgePnlUsd, hedgeCostUsd, fundingUsd, perUnderlying, ordersLastTick: this.lastOrders };
  }
}
