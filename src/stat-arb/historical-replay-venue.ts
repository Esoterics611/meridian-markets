import { Fill, ITradingVenue, PlaceOrderRequest } from './trading-venue.interface';
import { priceToMicros } from '../market-data/market-data.repository';
import { Bar } from './backtest/bar';

// HistoricalReplayVenue — an ITradingVenue for backtesting over REAL bars.
// BacktestRunner prices PnL from venue fills, so the venue must fill at the
// bar's close for the bar being processed. The runner encodes the bar index in
// each idempotencyKey as `backtest-${i}-${symbol}-${reason}` (see
// backtest-runner.ts); we parse `i` from it and fill at that bar's close. This
// is a deliberate contract with the runner's key format — kept here, in one
// place, with a fallback to the latest bar if the key is unexpected.

export class HistoricalReplayVenue implements ITradingVenue {
  readonly venueId: string;
  private readonly bySymbol = new Map<string, Bar[]>();
  private readonly takerFeeBps: bigint;

  constructor(
    series: Record<string, Bar[]>,
    opts: { venueId?: string; takerFeeBps?: bigint } = {},
  ) {
    for (const [sym, bars] of Object.entries(series)) this.bySymbol.set(sym, bars);
    this.venueId = opts.venueId ?? 'replay';
    this.takerFeeBps = opts.takerFeeBps ?? 5n;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    const idx = this.parseBarIndex(req.idempotencyKey);
    const priceMicros = await this.priceAt(req.symbol, idx);
    const feesUnits = (req.notionalUnits * this.takerFeeBps) / 10_000n;
    return {
      orderId: `${this.venueId}-${req.idempotencyKey}`,
      symbol: req.symbol,
      side: req.side,
      filledUnits: req.notionalUnits,
      priceMicros,
      feesUnits,
      executedAt: new Date(),
    };
  }

  async fetchPrice(symbol: string): Promise<bigint> {
    return this.priceAt(symbol, -1);
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
