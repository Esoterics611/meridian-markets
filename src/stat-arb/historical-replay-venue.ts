import { Fill, ITradingVenue, PlaceOrderRequest, Side } from './trading-venue.interface';
import { priceToMicros } from '../market-data/market-data.repository';
import { Bar } from './backtest/bar';

// HistoricalReplayVenue — an ITradingVenue for backtesting over REAL bars.
// BacktestRunner prices PnL from venue fills, so the venue must fill at the
// bar's close for the bar being processed. The runner encodes the bar index in
// each idempotencyKey as `backtest-${i}-${symbol}-${reason}` (see
// backtest-runner.ts); we parse `i` from it and fill at that bar's close. This
// is a deliberate contract with the runner's key format — kept here, in one
// place, with a fallback to the latest bar if the key is unexpected.
//
// SLIPPAGE (production-fidelity, P0.1): a taker fill never executes at the mid.
// Two costs worsen the fill price, charged on BOTH entry and exit legs:
//   • half-spread — the cost of crossing the bid-ask (bps of price), and
//   • linear market impact — λ·(notional / ADV), so big size in a thin leg pays
//     more (ADV = mean(volume×close) over the loaded bars, in USDC).
// BUY fills above the mid, SELL below. Both default to 0 → frictionless (the
// venue stays backward-compatible; callers opt in to honest costs).
//
// SHORT-BORROW / FINANCING (P0.4): stat-arb is short one leg, and borrowing it
// costs carry — negligible for easy-to-borrow large caps (~0.25–0.5%/yr), but
// material (10–100%+/yr) for hard-to-borrow names. For EQUITIES this is the
// dominant cost (commission ≈ 0, large-cap spread tiny), so it is not optional.
// The carry is a HOLD-DURATION cost, not a per-fill one, so the venue tracks
// per-symbol signed position + the bar index a short was opened (it already
// parses the bar index from the idempotency key) and charges
//   carry = shortNotional × borrowRate × (barsHeld × barSeconds / yearSeconds)
// on the COVERING fill (the BUY that closes a short). The runner sums every
// leg's feesUnits into the round-trip's total fees, so the carry lands in net
// P&L. Longs pay nothing. borrowBpsPerYear defaults to 0 → no behaviour change.

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface ReplayVenueOptions {
  venueId?: string;
  /** Per-leg taker fee, bps of notional. Default 5. */
  takerFeeBps?: bigint;
  /** Half the bid-ask spread, bps of price — cost of crossing on a taker fill. Default 0. */
  halfSpreadBps?: number;
  /** Linear market impact, bps at participation=1 (notional = one bar's ADV). Default 0. */
  impactLambdaBps?: number;
  /** Annualised short-borrow/financing rate on the short leg, bps/year. Default 0 (off). */
  borrowBpsPerYear?: number;
  /** Bar length in seconds — converts bars-held to a fraction of a year for the carry. Default 900 (15m). */
  barSeconds?: number;
}

/** Max adverse fill move, so a near-zero-ADV leg can't produce an absurd price. */
const MAX_ADVERSE_FRAC = 0.05; // 500 bps

interface ShortLot {
  /** Signed net position in notional units: + long, − short. */
  position: bigint;
  /** Bar index at which the current net-short position was opened (if short). */
  shortOpenIdx: number;
}

export class HistoricalReplayVenue implements ITradingVenue {
  readonly venueId: string;
  private readonly bySymbol = new Map<string, Bar[]>();
  private readonly takerFeeBps: bigint;
  private readonly halfSpreadFrac: number;
  private readonly impactLambda: number; // fraction of price at participation=1
  private readonly borrowRateFrac: number; // annualised, as a fraction
  private readonly barSeconds: number;
  private readonly advMicrosCache = new Map<string, number>();
  private readonly lots = new Map<string, ShortLot>();

  constructor(series: Record<string, Bar[]>, opts: ReplayVenueOptions = {}) {
    for (const [sym, bars] of Object.entries(series)) this.bySymbol.set(sym, bars);
    this.venueId = opts.venueId ?? 'replay';
    this.takerFeeBps = opts.takerFeeBps ?? 5n;
    this.halfSpreadFrac = Math.max(0, opts.halfSpreadBps ?? 0) / 10_000;
    this.impactLambda = Math.max(0, opts.impactLambdaBps ?? 0) / 10_000;
    this.borrowRateFrac = Math.max(0, opts.borrowBpsPerYear ?? 0) / 10_000;
    this.barSeconds = Math.max(0, opts.barSeconds ?? 900);
  }

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    const idx = this.parseBarIndex(req.idempotencyKey);
    const mid = await this.priceAt(req.symbol, idx);
    const priceMicros = this.applySlippage(mid, req.symbol, req.side, req.notionalUnits);
    const takerFee = (req.notionalUnits * this.takerFeeBps) / 10_000n;
    const borrow = this.chargeBorrow(req.symbol, req.side, req.notionalUnits, idx);
    return {
      orderId: `${this.venueId}-${req.idempotencyKey}`,
      symbol: req.symbol,
      side: req.side,
      filledUnits: req.notionalUnits,
      priceMicros,
      feesUnits: takerFee + borrow,
      executedAt: new Date(),
    };
  }

  /**
   * Update the per-symbol signed position and, when this fill covers a short,
   * return the borrow carry accrued over the holding period. No-op (returns 0)
   * when borrow is disabled or the fill doesn't reduce a short.
   */
  private chargeBorrow(symbol: string, side: Side, notionalUnits: bigint, idx: number): bigint {
    if (this.borrowRateFrac === 0 || this.barSeconds === 0) {
      // Still track position so enabling borrow later is consistent, but no charge.
      this.updatePosition(symbol, side, notionalUnits, idx);
      return 0n;
    }
    const lot = this.lots.get(symbol) ?? { position: 0n, shortOpenIdx: idx };
    const delta = side === 'BUY' ? notionalUnits : -notionalUnits;
    let carry = 0n;
    // A BUY against a net-short position covers (some of) the short → charge carry.
    if (lot.position < 0n && delta > 0n) {
      const closedShort = delta < -lot.position ? delta : -lot.position;
      const barsHeld = Math.max(0, idx - lot.shortOpenIdx);
      const yearFrac = (barsHeld * this.barSeconds) / SECONDS_PER_YEAR;
      carry = BigInt(Math.round(Number(closedShort) * this.borrowRateFrac * yearFrac));
    }
    this.updatePosition(symbol, side, notionalUnits, idx);
    return carry;
  }

  private updatePosition(symbol: string, side: Side, notionalUnits: bigint, idx: number): void {
    const lot = this.lots.get(symbol) ?? { position: 0n, shortOpenIdx: idx };
    const delta = side === 'BUY' ? notionalUnits : -notionalUnits;
    const prev = lot.position;
    lot.position = prev + delta;
    // Stamp the open-index when a fresh short is established (crossed into short).
    if (prev >= 0n && lot.position < 0n) lot.shortOpenIdx = idx;
    this.lots.set(symbol, lot);
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    return this.priceAt(symbol, -1);
  }

  /** Worsen the mid by half-spread + linear impact; BUY pays up, SELL receives less. */
  private applySlippage(mid: bigint, symbol: string, side: Side, notionalUnits: bigint): bigint {
    if (this.halfSpreadFrac === 0 && this.impactLambda === 0) return mid; // frictionless
    const adv = this.advMicrosFor(symbol);
    const participation = adv > 0 ? Number(notionalUnits) / adv : 0;
    const adverse = Math.min(this.halfSpreadFrac + this.impactLambda * participation, MAX_ADVERSE_FRAC);
    const factor = side === 'BUY' ? 1 + adverse : 1 - adverse;
    return BigInt(Math.round(Number(mid) * factor));
  }

  /** Average dollar volume per bar (USDC micros) — the impact denominator. */
  private advMicrosFor(symbol: string): number {
    const cached = this.advMicrosCache.get(symbol);
    if (cached !== undefined) return cached;
    const bars = this.bySymbol.get(symbol) ?? [];
    let sum = 0;
    for (const b of bars) sum += b.volume * b.close;
    const adv = bars.length > 0 ? (sum / bars.length) * 1e6 : 0;
    this.advMicrosCache.set(symbol, adv);
    return adv;
  }

  private async priceAt(symbol: string, idx: number): Promise<bigint> {
    const bars = this.bySymbol.get(symbol);
    if (!bars || bars.length === 0) return 0n;
    const bar = idx >= 0 && idx < bars.length ? bars[idx] : bars[bars.length - 1];
    return priceToMicros(bar.close);
  }

  private parseBarIndex(key: string): number {
    const m = key.match(/^backtest-(\d+)-/);
    return m ? Number(m[1]) : -1;
  }
}
