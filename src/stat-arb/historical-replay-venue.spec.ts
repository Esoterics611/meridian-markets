import { HistoricalReplayVenue } from './historical-replay-venue';
import { Bar } from './backtest/bar';

function bars(symbol: string, closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol,
    timestamp: new Date(i * 60_000),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

describe('HistoricalReplayVenue', () => {
  const venue = new HistoricalReplayVenue(
    { BTC: bars('BTC', [100, 110, 120]), ETH: bars('ETH', [10, 11, 12]) },
    { takerFeeBps: 0n },
  );

  it('fills at the bar-close encoded in the runner idempotency key', async () => {
    const fill = await venue.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      notionalUnits: 1_000_000n,
      idempotencyKey: 'backtest-1-BTC-OPEN_LONG',
    });
    expect(fill.priceMicros).toBe(110_000_000n); // bar index 1 close = 110
  });

  it('falls back to the latest bar when the key has no index', async () => {
    const fill = await venue.placeOrder({
      symbol: 'ETH',
      side: 'SELL',
      notionalUnits: 1_000_000n,
      idempotencyKey: 'manual',
    });
    expect(fill.priceMicros).toBe(12_000_000n); // last ETH close = 12
  });

  it('applies taker fees', async () => {
    const feeVenue = new HistoricalReplayVenue({ BTC: bars('BTC', [100]) }, { takerFeeBps: 5n });
    const fill = await feeVenue.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      notionalUnits: 1_000_000_000n,
      idempotencyKey: 'backtest-0-BTC-OPEN_LONG',
    });
    expect(fill.feesUnits).toBe(500_000n); // 1000e6 * 5 / 10000
  });

  it('half-spread worsens the fill: BUY above mid, SELL below — symmetrically', async () => {
    const v = new HistoricalReplayVenue({ BTC: bars('BTC', [100]) }, { takerFeeBps: 0n, halfSpreadBps: 10 });
    const buy = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000_000n, idempotencyKey: 'backtest-0-BTC-OPEN_LONG' });
    const sell = await v.placeOrder({ symbol: 'BTC', side: 'SELL', notionalUnits: 1_000_000n, idempotencyKey: 'backtest-0-BTC-OPEN_LONG' });
    expect(buy.priceMicros).toBe(100_100_000n); // 100 × (1 + 10bps)
    expect(sell.priceMicros).toBe(99_900_000n); // 100 × (1 − 10bps)
  });

  it('market impact scales with participation (notional / ADV)', async () => {
    // ADV = mean(volume×close). volume=1, close=100 → ADV = 100 USDC = 100e6 micros.
    const v = new HistoricalReplayVenue({ BTC: bars('BTC', [100]) }, { takerFeeBps: 0n, impactLambdaBps: 10 });
    // notional = ADV (100e6) → participation 1 → impact = 10bps → BUY at 100×1.001.
    const atAdv = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 100_000_000n, idempotencyKey: 'backtest-0-BTC-OPEN_LONG' });
    expect(atAdv.priceMicros).toBe(100_100_000n);
    // 10× the notional → 10× participation → ~100bps impact → strictly worse fill.
    const big = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000_000_000n, idempotencyKey: 'backtest-0-BTC-OPEN_LONG' });
    expect(big.priceMicros).toBeGreaterThan(atAdv.priceMicros);
  });

  it('is frictionless by default (no slippage params) — fills exactly at close', async () => {
    const v = new HistoricalReplayVenue({ BTC: bars('BTC', [100]) }, { takerFeeBps: 0n });
    const fill = await v.placeOrder({ symbol: 'BTC', side: 'BUY', notionalUnits: 1_000_000_000n, idempotencyKey: 'backtest-0-BTC-OPEN_LONG' });
    expect(fill.priceMicros).toBe(100_000_000n);
  });
});
