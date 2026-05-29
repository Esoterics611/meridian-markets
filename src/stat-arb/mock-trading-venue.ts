import { Injectable } from '@nestjs/common';
import {
  Fill,
  ITradingVenue,
  PlaceOrderRequest,
} from './trading-venue.interface';

// Deterministic mock venue. Price for each symbol is a sine-wave + linear
// drift seeded by the symbol name; that gives a clean oscillating spread for
// the demo without any randomness, so backtests are bit-stable across runs.
//
// Same swap-seam pattern as MockHedgeVenue / MockYieldProvider — flipping to
// a real exchange is a one-line factory change in StatArbModule, behind the
// LIVE_TRADING_ARMED engineering arm switch.

const BASE_PRICE_MICROS = 1_000_000n; // $1.00 reference; symbol-specific multiplier applied below
const TAKER_FEE_BPS = 5n; // 5 bps = 0.05% taker fee (Binance spot tier 1, post-VIP rebates ignored)

interface SymbolModel {
  /** Mean price in micros */
  meanMicros: bigint;
  /** Sine amplitude as fraction of mean */
  amplitudeFrac: number;
  /** Sine period in seconds */
  periodSec: number;
  /** Linear drift per day, as fraction of mean */
  driftPerDay: number;
}

@Injectable()
export class MockTradingVenue implements ITradingVenue {
  readonly venueId = 'mock';

  private readonly seenOrders = new Map<string, Fill>();
  private orderNonce = 0;

  constructor(
    private readonly takerFeeBps: bigint = TAKER_FEE_BPS,
    private readonly now: () => Date = () => new Date(),
    private readonly epoch: Date = new Date('2026-01-01T00:00:00Z'),
  ) {}

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    const cached = this.seenOrders.get(req.idempotencyKey);
    if (cached) return cached;

    if (req.notionalUnits <= 0n) {
      throw new Error(`notionalUnits must be > 0; got ${req.notionalUnits}`);
    }

    const priceMicros = await this.fetchPrice(req.symbol);
    // Fee = notional * taker_fee_bps / 10000.
    const feesUnits = (req.notionalUnits * this.takerFeeBps) / 10_000n;
    const fill: Fill = {
      orderId: `mock-ord-${++this.orderNonce}`,
      symbol: req.symbol,
      side: req.side,
      filledUnits: req.notionalUnits,
      priceMicros,
      feesUnits,
      executedAt: this.now(),
    };
    this.seenOrders.set(req.idempotencyKey, fill);
    return fill;
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    const model = this.modelFor(symbol);
    const elapsedSec = (this.now().getTime() - this.epoch.getTime()) / 1000;
    const dayFrac = elapsedSec / 86_400;
    const sineFrac = model.amplitudeFrac * Math.sin((2 * Math.PI * elapsedSec) / model.periodSec);
    const driftFrac = model.driftPerDay * dayFrac;
    const fracTotal = 1 + sineFrac + driftFrac;
    const meanFloat = Number(model.meanMicros);
    return BigInt(Math.max(1, Math.round(meanFloat * fracTotal)));
  }

  /** Deterministic per-symbol model — same symbol always gives the same params. */
  private modelFor(symbol: string): SymbolModel {
    // Hash the symbol into stable per-symbol params (no randomness).
    let h = 2166136261;
    for (let i = 0; i < symbol.length; i++) {
      h ^= symbol.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = h >>> 0;
    const meanMultiplier = 1 + (h % 1000); // mean price ~$1..$1000
    const amplitude = 0.005 + ((h >>> 7) % 100) / 10_000; // 0.5%..1.5% amplitude
    const period = 60 * (10 + ((h >>> 13) % 50)); // 10..60 min period
    const drift = (((h >>> 19) % 21) - 10) / 10_000; // -10..+10 bps/day
    return {
      meanMicros: BASE_PRICE_MICROS * BigInt(meanMultiplier),
      amplitudeFrac: amplitude,
      periodSec: period,
      driftPerDay: drift,
    };
  }
}
