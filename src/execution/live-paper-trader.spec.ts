import { LivePaperTrader, LiveStrategy, legPnlUnits } from './live-paper-trader';
import { Bar } from '../stat-arb/backtest/bar';
import { Fill, ITradingVenue, PlaceOrderRequest } from '../stat-arb/trading-venue.interface';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import { DesiredOrder } from '../stat-arb/backtest/strategy.interface';

function bar(symbol: string, close: number, t: number): Bar {
  return { symbol, timestamp: new Date(t), open: close, high: close, low: close, close, volume: 1 };
}

class FakeFeed implements IBarFeed {
  readonly feedId = 'fake';
  constructor(private readonly qa: Bar[], private readonly qb: Bar[], private readonly symbolA: string) {}
  async nextBar(symbol: string): Promise<Bar | null> {
    const q = symbol === this.symbolA ? this.qa : this.qb;
    return q.shift() ?? null;
  }
}

class FakeVenue implements ITradingVenue {
  readonly venueId = 'paper-test';
  prices: Record<string, bigint> = {};
  feeBps = 0n;
  placed: PlaceOrderRequest[] = [];
  async placeOrder(req: PlaceOrderRequest): Promise<Fill> {
    this.placed.push(req);
    return {
      orderId: `o${this.placed.length}`,
      symbol: req.symbol,
      side: req.side,
      filledUnits: req.notionalUnits,
      priceMicros: this.prices[req.symbol],
      feesUnits: (req.notionalUnits * this.feeBps) / 10_000n,
      executedAt: new Date(),
    };
  }
  async fetchPrice(symbol: string): Promise<bigint> {
    return this.prices[symbol];
  }
}

// Scripted strategy: OPEN_LONG on the first bar, CLOSE on the second.
function scriptedStrategy(notional: bigint): LiveStrategy {
  let calls = 0;
  return {
    lastZ: NaN,
    currentBeta: () => 1,
    currentRegime: () => 'FLAT',
    onBar(): DesiredOrder[] {
      calls += 1;
      if (calls === 1) {
        this.lastZ = 2.0;
        return [
          { symbol: 'BTC', side: 'BUY', notionalUnits: notional, reason: 'OPEN_LONG' },
          { symbol: 'ETH', side: 'SELL', notionalUnits: notional, reason: 'OPEN_LONG' },
        ];
      }
      if (calls === 2) {
        this.lastZ = 0.1;
        return [
          { symbol: 'BTC', side: 'SELL', notionalUnits: notional, reason: 'CLOSE' },
          { symbol: 'ETH', side: 'BUY', notionalUnits: notional, reason: 'CLOSE' },
        ];
      }
      return [];
    },
  };
}

const M = 1_000_000n;

describe('legPnlUnits', () => {
  it('long leg profits on a price rise', () => {
    // 1000 USDC notional, entry 100, exit 110 -> +100 USDC.
    expect(legPnlUnits(1_000_000_000n, 100n * M, 110n * M, true)).toBe(100_000_000n);
  });
  it('short leg profits on a price fall', () => {
    expect(legPnlUnits(1_000_000_000n, 100n * M, 90n * M, false)).toBe(100_000_000n);
  });
  it('returns 0 on zero entry price', () => {
    expect(legPnlUnits(1_000_000_000n, 0n, 110n * M, true)).toBe(0n);
  });
});

describe('LivePaperTrader', () => {
  const cfg = { symbolA: 'BTC', symbolB: 'ETH', pollIntervalMs: 10 };

  it('opens then closes a round-trip and books realised PnL', async () => {
    const notional = 1_000_000_000n; // 1000 USDC
    const feed = new FakeFeed(
      [bar('BTC', 100, 1_000), bar('BTC', 110, 61_000)],
      [bar('ETH', 100, 1_000), bar('ETH', 100, 61_000)],
      'BTC',
    );
    const venue = new FakeVenue();
    const trader = new LivePaperTrader(scriptedStrategy(notional), venue, feed, cfg);

    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick(); // open LONG
    expect(trader.snapshot().openPosition).not.toBeNull();

    venue.prices = { BTC: 110n * M, ETH: 100n * M };
    await trader.tick(); // close

    const snap = trader.snapshot();
    expect(snap.openPosition).toBeNull();
    expect(snap.closedTradeCount).toBe(1);
    // BTC long +10%, ETH short flat, no fees -> +100 USDC.
    expect(snap.realisedPnlUnits).toBe('100000000');
    expect(snap.recentTrades[0]).toMatchObject({ side: 'LONG', entryZ: 2.0, exitZ: 0.1 });
  });

  it('subtracts fees from realised PnL', async () => {
    const notional = 1_000_000_000n;
    const feed = new FakeFeed(
      [bar('BTC', 100, 1_000), bar('BTC', 110, 61_000)],
      [bar('ETH', 100, 1_000), bar('ETH', 100, 61_000)],
      'BTC',
    );
    const venue = new FakeVenue();
    venue.feeBps = 5n; // 5 bps per fill, 4 fills
    const trader = new LivePaperTrader(scriptedStrategy(notional), venue, feed, cfg);
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick();
    venue.prices = { BTC: 110n * M, ETH: 100n * M };
    await trader.tick();
    // gross +100 USDC; fees = 4 * (1000e6 * 5 / 10000) = 4 * 500_000 = 2_000_000.
    expect(trader.snapshot().realisedPnlUnits).toBe((100_000_000n - 2_000_000n).toString());
  });

  it('marks the open position to market', async () => {
    const notional = 1_000_000_000n;
    const feed = new FakeFeed([bar('BTC', 100, 1_000)], [bar('ETH', 100, 1_000)], 'BTC');
    const venue = new FakeVenue();
    const trader = new LivePaperTrader(scriptedStrategy(notional), venue, feed, cfg);
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick(); // open at 100/100; bar closes are 100/100 so MTM = 0
    expect(trader.snapshot().unrealisedPnlUnits).toBe('0');
  });

  it('does nothing when the feed has no new bar', async () => {
    const feed = new FakeFeed([], [], 'BTC');
    const venue = new FakeVenue();
    const trader = new LivePaperTrader(scriptedStrategy(1_000_000n), venue, feed, cfg);
    await trader.tick();
    expect(trader.snapshot().barsSeen).toBe(0);
    expect(venue.placed).toHaveLength(0);
  });

  it('start/stop toggles running state', () => {
    const feed = new FakeFeed([], [], 'BTC');
    const trader = new LivePaperTrader(scriptedStrategy(1_000_000n), new FakeVenue(), feed, cfg);
    expect(trader.isRunning()).toBe(false);
    trader.start();
    expect(trader.isRunning()).toBe(true);
    trader.stop();
    expect(trader.isRunning()).toBe(false);
  });
});
