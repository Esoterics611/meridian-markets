/**
 * vrp-book — the VRP satellite (PROFIT_PIVOT_II E6/M3): short the variance risk premium,
 * delta-hedged, defined by the desk's own measurements:
 *   #12: BTC implied − realized = +5.9 vol pts, ETH +3.7 (Greeks validated vs Deribit);
 *   #42: short-vol won 86.3% of 117 rolling 24h windows — the fat left tail is the 13.7%.
 *
 * v0 shape: sell one ATM straddle on the nearest daily expiry, delta-hedge with a paper
 * perp at a band, hold to expiry, settle cash. Entry is GATED on the measured premium
 * (iv − rv ≥ minVrpPts): when the gate is closed the book sits out — doctrine #5, and
 * the answer to the fat tail is *not being short vol when there is no premium to sell*.
 *
 * Sizing is the whole risk story (mandate M3): maxLossBudgetUsd caps the tail via a
 * hard stop — if the marked loss exceeds the budget the book closes the straddle at
 * the stop (paper: buys back at intrinsic + remaining time value marked at entry IV).
 * All money plain USD. Paper-only.
 */
import { blackScholes } from '../greeks/black-scholes';

export interface VrpBookConfig {
  /** Enter only when (markIv − realizedVol) ≥ this, vol points as fraction (0.03 = 3pts). */
  minVrpPts: number;
  /** Straddle size in coin units (BTC: 0.1 ≈ $6k notional at 60k). */
  contractsCoin: number;
  /** Re-hedge when |net delta| (coin units) drifts past this fraction of contracts. */
  hedgeBandFrac: number;
  /** Taker fee on the perp hedge, bps of hedge notional. */
  hedgeFeeBps: number;
  /** Hard stop: close the position when marked loss exceeds this (USD). */
  maxLossBudgetUsd: number;
  /** No entry when the straddle has less than this many hours of life. */
  minHoursToExpiry: number;
}

export const DEFAULT_VRP_CONFIG: VrpBookConfig = {
  minVrpPts: 0.03,
  contractsCoin: 0.1,
  hedgeBandFrac: 0.25,
  hedgeFeeBps: 3.5,
  maxLossBudgetUsd: 400,
  minHoursToExpiry: 6,
};

export interface StraddlePosition {
  underlying: string;
  strike: number;
  expiryMs: number;
  contracts: number;
  /** Entry IV (fraction) — also the marking vol for the life of the position (v0 honest simplification, stated). */
  entryIv: number;
  /** Total premium collected, USD. */
  premiumUsd: number;
  openedMs: number;
  /** Perp hedge position, coin units (+ = long). */
  hedgeQty: number;
  hedgeAvgPx: number;
  hedgeRealisedUsd: number;
  hedgeFeesUsd: number;
  rehedges: number;
  status: 'OPEN' | 'SETTLED' | 'STOPPED';
  realisedUsd?: number;
  closedMs?: number;
}

export interface VrpSnapshot {
  open: boolean;
  realisedTotalUsd: number;
  settled: number;
  stopped: number;
  wins: number;
  losses: number;
  premiumCollectedUsd: number;
  hedgeFeesUsd: number;
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export class VrpBook {
  private pos: StraddlePosition | null = null;
  private realisedTotal = 0;
  private premiumCollected = 0;
  private hedgeFeesTotal = 0;
  private settled = 0;
  private stopped = 0;
  private wins = 0;
  private losses = 0;

  constructor(private readonly cfg: VrpBookConfig = DEFAULT_VRP_CONFIG) {}

  /** Gate + open. Returns null (with reason) when the desk should sit out. */
  tryOpen(p: {
    underlying: string;
    spot: number;
    strike: number;
    expiryMs: number;
    markIv: number;
    realizedVol: number;
    /** Executable straddle premium, USD per contract (mid − haircut, caller-computed). */
    straddlePremiumUsd: number;
    nowMs: number;
  }): { pos: StraddlePosition | null; reason?: string } {
    if (this.pos?.status === 'OPEN') return { pos: null, reason: 'position-open' };
    const vrp = p.markIv - p.realizedVol;
    if (vrp < this.cfg.minVrpPts) {
      return { pos: null, reason: `VRP gate closed: iv−rv = ${(vrp * 100).toFixed(1)}pts < ${(this.cfg.minVrpPts * 100).toFixed(0)}pts` };
    }
    const hoursLeft = (p.expiryMs - p.nowMs) / 3_600_000;
    if (hoursLeft < this.cfg.minHoursToExpiry) return { pos: null, reason: `only ${hoursLeft.toFixed(1)}h to expiry` };

    const premiumUsd = p.straddlePremiumUsd * this.cfg.contractsCoin;
    this.pos = {
      underlying: p.underlying,
      strike: p.strike,
      expiryMs: p.expiryMs,
      contracts: this.cfg.contractsCoin,
      entryIv: p.markIv,
      premiumUsd,
      openedMs: p.nowMs,
      hedgeQty: 0,
      hedgeAvgPx: 0,
      hedgeRealisedUsd: 0,
      hedgeFeesUsd: 0,
      rehedges: 0,
      status: 'OPEN',
    };
    this.premiumCollected += premiumUsd;
    return { pos: this.pos };
  }

  /** Net delta of the SHORT straddle + hedge, coin units. */
  netDelta(spot: number, nowMs: number): number {
    const pos = this.pos;
    if (!pos || pos.status !== 'OPEN') return 0;
    const tYears = Math.max((pos.expiryMs - nowMs) / YEAR_MS, 0);
    const call = blackScholes({ type: 'CALL', spot, strike: pos.strike, tYears, iv: pos.entryIv, rate: 0 });
    const put = blackScholes({ type: 'PUT', spot, strike: pos.strike, tYears, iv: pos.entryIv, rate: 0 });
    return -(call.delta + put.delta) * pos.contracts + pos.hedgeQty;
  }

  /**
   * One mark-and-hedge step. Rehedges past the band, enforces the loss stop.
   * Returns what it did so the runner can log it as a business event.
   */
  step(spot: number, nowMs: number): { rehedged?: { qty: number; px: number }; stoppedOut?: StraddlePosition; markPnlUsd?: number } {
    const pos = this.pos;
    if (!pos || pos.status !== 'OPEN') return {};

    const markPnl = this.markPnlUsd(spot, nowMs);
    if (markPnl < -this.cfg.maxLossBudgetUsd) {
      const closed = this.closeAt(spot, nowMs, 'STOPPED');
      return { stoppedOut: closed, markPnlUsd: markPnl };
    }

    const delta = this.netDelta(spot, nowMs);
    if (Math.abs(delta) > this.cfg.hedgeBandFrac * pos.contracts) {
      const qty = -delta; // trade to flat
      const fee = Math.abs(qty) * spot * (this.cfg.hedgeFeeBps / 10_000);
      const newQty = pos.hedgeQty + qty;
      if (pos.hedgeQty === 0) {
        pos.hedgeAvgPx = spot;
      } else if (Math.sign(qty) === Math.sign(pos.hedgeQty)) {
        // adding: weighted-average entry
        pos.hedgeAvgPx =
          (pos.hedgeAvgPx * Math.abs(pos.hedgeQty) + spot * Math.abs(qty)) /
          (Math.abs(pos.hedgeQty) + Math.abs(qty));
      } else {
        // reducing/flipping: realise the closed portion against avg cost
        const closing = Math.min(Math.abs(qty), Math.abs(pos.hedgeQty));
        pos.hedgeRealisedUsd += closing * (spot - pos.hedgeAvgPx) * Math.sign(pos.hedgeQty);
        if (Math.abs(qty) > Math.abs(pos.hedgeQty)) pos.hedgeAvgPx = spot; // flipped: remainder opens here
      }
      pos.hedgeQty = newQty;
      pos.hedgeFeesUsd += fee;
      this.hedgeFeesTotal += fee;
      pos.rehedges += 1;
      return { rehedged: { qty, px: spot }, markPnlUsd: markPnl };
    }
    return { markPnlUsd: markPnl };
  }

  /** Cash-settle at expiry. */
  settle(spotAtExpiry: number, nowMs: number): StraddlePosition | null {
    const pos = this.pos;
    if (!pos || pos.status !== 'OPEN') return null;
    return this.closeAt(spotAtExpiry, nowMs, 'SETTLED');
  }

  /** Marked P&L: premium − straddle mark (entry IV) + hedge P&L − fees. */
  markPnlUsd(spot: number, nowMs: number): number {
    const pos = this.pos!;
    const tYears = Math.max((pos.expiryMs - nowMs) / YEAR_MS, 0);
    const call = blackScholes({ type: 'CALL', spot, strike: pos.strike, tYears, iv: pos.entryIv, rate: 0 });
    const put = blackScholes({ type: 'PUT', spot, strike: pos.strike, tYears, iv: pos.entryIv, rate: 0 });
    const straddleMark = (call.price + put.price) * pos.contracts;
    const hedgeUnrealised = pos.hedgeQty * (spot - pos.hedgeAvgPx);
    return pos.premiumUsd - straddleMark + pos.hedgeRealisedUsd + hedgeUnrealised - pos.hedgeFeesUsd;
  }

  private closeAt(spot: number, nowMs: number, status: 'SETTLED' | 'STOPPED'): StraddlePosition {
    const pos = this.pos!;
    // close hedge at spot (fee), straddle at mark (settled ⇒ tYears→0 ⇒ intrinsic)
    const hedgeCloseFee = Math.abs(pos.hedgeQty) * spot * (this.cfg.hedgeFeeBps / 10_000);
    pos.hedgeFeesUsd += hedgeCloseFee;
    this.hedgeFeesTotal += hedgeCloseFee;
    const realised = this.markPnlUsd(spot, status === 'SETTLED' ? Math.max(nowMs, pos.expiryMs) : nowMs);
    pos.status = status;
    pos.realisedUsd = realised;
    pos.closedMs = nowMs;
    this.realisedTotal += realised;
    if (status === 'SETTLED') this.settled += 1;
    else this.stopped += 1;
    if (realised >= 0) this.wins += 1;
    else this.losses += 1;
    return pos;
  }

  position(): StraddlePosition | null {
    return this.pos;
  }

  snapshot(): VrpSnapshot {
    return {
      open: this.pos?.status === 'OPEN',
      realisedTotalUsd: this.realisedTotal,
      settled: this.settled,
      stopped: this.stopped,
      wins: this.wins,
      losses: this.losses,
      premiumCollectedUsd: this.premiumCollected,
      hedgeFeesUsd: this.hedgeFeesTotal,
    };
  }
}
