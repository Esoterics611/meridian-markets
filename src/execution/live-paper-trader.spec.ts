import { LivePaperTrader, LiveStrategy, legPnlUnits } from './live-paper-trader';
import { Bar } from '../stat-arb/backtest/bar';
import { Fill, ITradingVenue, PlaceOrderRequest } from '../stat-arb/trading-venue.interface';
import { IBarFeed } from '../stat-arb/feed/live-feed.interface';
import { DesiredOrder } from '../stat-arb/backtest/strategy.interface';
import { DeskEventInput } from '../market-making/events/desk-event';
import { IDeskEventSink } from '../market-making/events/desk-event-sink';

/** Records every emitted business event for assertion. */
class CapturingSink implements IDeskEventSink {
  readonly events: DeskEventInput[] = [];
  emit(event: DeskEventInput): void {
    this.events.push(event);
  }
}

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

  it('setStartingCapital sets capital + equity and resets realised PnL', async () => {
    const notional = 1_000_000_000n;
    const feed = new FakeFeed(
      [bar('BTC', 100, 1_000), bar('BTC', 110, 61_000)],
      [bar('ETH', 100, 1_000), bar('ETH', 100, 61_000)],
      'BTC',
    );
    const venue = new FakeVenue();
    const trader = new LivePaperTrader(scriptedStrategy(notional), venue, feed, cfg);
    trader.setStartingCapital(50_000n * M); // 50,000 USDC
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick();
    venue.prices = { BTC: 110n * M, ETH: 100n * M };
    await trader.tick(); // +100 USDC realised
    const snap = trader.snapshot();
    expect(snap.capitalUnits).toBe((50_000n * M).toString());
    expect(snap.equityUnits).toBe((50_000n * M + 100_000_000n).toString());
    expect(() => trader.setStartingCapital(0n)).toThrow(/positive/);
  });

  it('reconfigure repoints the pair, wipes the book, and rebuilds via the factory', async () => {
    const feed = new FakeFeed(
      [bar('BTC', 100, 1_000), bar('BTC', 110, 61_000)],
      [bar('ETH', 100, 1_000), bar('ETH', 100, 61_000)],
      'BTC',
    );
    const venue = new FakeVenue();
    let builtFor: { symbolA: string; symbolB: string; beta?: number } | null = null;
    const factory = (opts: { symbolA: string; symbolB: string; beta?: number }) => {
      builtFor = opts;
      return scriptedStrategy(1_000_000_000n);
    };
    const trader = new LivePaperTrader(
      scriptedStrategy(1_000_000_000n), venue, feed, cfg, undefined, undefined, factory,
    );
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick(); // open a position, accrue a bar
    expect(trader.snapshot().barsSeen).toBe(1);

    trader.reconfigure({ symbolA: 'SOL', symbolB: 'AVAX', beta: 1.4 });
    const snap = trader.snapshot();
    expect(snap.symbolA).toBe('SOL');
    expect(snap.symbolB).toBe('AVAX');
    expect(snap.barsSeen).toBe(0);
    expect(snap.openPosition).toBeNull();
    expect(snap.running).toBe(false);
    expect(builtFor).toEqual({ symbolA: 'SOL', symbolB: 'AVAX', beta: 1.4 });
  });

  it('reconfigure without a factory falls back to strategy.reset()', () => {
    const feed = new FakeFeed([], [], 'BTC');
    const strat = scriptedStrategy(1_000_000n);
    let didReset = false;
    strat.reset = () => { didReset = true; };
    const trader = new LivePaperTrader(strat, new FakeVenue(), feed, cfg);
    trader.reconfigure({ symbolA: 'AAVE', symbolB: 'UNI' });
    expect(didReset).toBe(true);
    expect(trader.snapshot().symbolA).toBe('AAVE');
  });

  it('emits OPEN then CLOSE business events through the desk-event sink', async () => {
    const notional = 1_000_000_000n;
    const feed = new FakeFeed(
      [bar('BTC', 100, 1_000), bar('BTC', 110, 61_000)],
      [bar('ETH', 100, 1_000), bar('ETH', 100, 61_000)],
      'BTC',
    );
    const venue = new FakeVenue();
    const sink = new CapturingSink();
    const trader = new LivePaperTrader(
      scriptedStrategy(notional), venue, feed, cfg, undefined, undefined, undefined, undefined, sink,
    );
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    await trader.tick(); // open LONG
    venue.prices = { BTC: 110n * M, ETH: 100n * M };
    await trader.tick(); // close

    const fills = sink.events.filter((e) => e.kind === 'fill');
    expect(fills.map((e) => e.action)).toEqual(['open', 'close']);
    expect(fills.every((e) => e.desk === 'stat-arb' && e.book === 'BTC/ETH')).toBe(true);
    // The CLOSE carries the booked round-trip P&L (+100 USDC, no fees).
    expect(fills[1].realisedDeltaUnits).toBe('100000000');
  });

  it('emits a risk-block business event when an OPEN is denied', async () => {
    const denyEngine = {
      preTradeCheck: () => [{ allow: false as const, reason: 'drawdown breach' }],
      drainEvents: () => [{ kind: 'DRAWDOWN' as const, barIndex: 0, reason: 'drawdown breach' }],
    };
    const feed = new FakeFeed([bar('BTC', 100, 1_000)], [bar('ETH', 100, 1_000)], 'BTC');
    const venue = new FakeVenue();
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    const sink = new CapturingSink();
    const trader = new LivePaperTrader(
      scriptedStrategy(1_000_000_000n), venue, feed, { ...cfg, riskEngine: denyEngine },
      undefined, undefined, undefined, undefined, sink,
    );
    await trader.tick();
    const blocks = sink.events.filter((e) => e.kind === 'verdict');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].message).toContain('blocked by risk gate');
  });

  it('blocks an OPEN when the risk engine denies, and never places the order', async () => {
    const denyEngine = {
      preTradeCheck: () => [{ allow: false as const, reason: 'drawdown breach' }],
      drainEvents: () => [{ kind: 'DRAWDOWN' as const, barIndex: 0, reason: 'drawdown breach' }],
    };
    let rolledBack = false;
    const strat = scriptedStrategy(1_000_000_000n);
    strat.rollbackEntry = () => {
      rolledBack = true;
    };
    const feed = new FakeFeed([bar('BTC', 100, 1_000)], [bar('ETH', 100, 1_000)], 'BTC');
    const venue = new FakeVenue();
    venue.prices = { BTC: 100n * M, ETH: 100n * M };
    const trader = new LivePaperTrader(strat, venue, feed, { ...cfg, riskEngine: denyEngine });
    await trader.tick();
    const snap = trader.snapshot();
    expect(snap.openPosition).toBeNull();
    expect(snap.blockedEntries).toBe(1);
    expect(venue.placed).toHaveLength(0); // no order ever placed
    expect(rolledBack).toBe(true);
  });
});
