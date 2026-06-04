import { LivePortfolioTrader, PortfolioPair } from './live-portfolio-trader';
import { LivePaperTrader, StatArbBookState } from './live-paper-trader';
import { DeskEventInput } from '../market-making/events/desk-event';
import { IDeskEventSink } from '../market-making/events/desk-event-sink';
import { IStatArbStateStore, StatArbBookRecord } from '../stat-arb/persistence/stat-arb-state-store.interface';

const M = 1_000_000n;

const flatState = (): StatArbBookState => ({
  realisedPnlUnits: '0', closedTradeCount: 0, peakNav: 1, barsSeen: 0, seededBars: 0, blockedEntries: 0, open: null,
});

/** A capturing store to assert checkpoints + soft-closes + rehydration. */
class FakeStore implements IStatArbStateStore {
  enabled = true;
  saved: StatArbBookRecord[] = [];
  closed: string[] = [];
  open: StatArbBookRecord[] = [];
  async save(r: StatArbBookRecord) { this.saved.push(r); }
  async loadOpen() { return this.open; }
  async close(k: string) { this.closed.push(k); }
}

class CapturingSink implements IDeskEventSink {
  readonly events: DeskEventInput[] = [];
  emit(event: DeskEventInput): void {
    this.events.push(event);
  }
}

// Minimal fake sub-trader: the portfolio only calls setStartingCapital / tick /
// snapshot on each book, so we stub exactly those.
function fakeTrader(pair: PortfolioPair) {
  let capital = 0n;
  let ticks = 0;
  let restored: StatArbBookState | null = null;
  return {
    _capital: () => capital,
    _ticks: () => ticks,
    _restored: () => restored,
    setStartingCapital(u: bigint) { capital = u; },
    async tick() { ticks += 1; },
    async flatten() { return false; },
    capital() { return capital; },
    serializeState(): StatArbBookState { return flatState(); },
    restoreState(s: StatArbBookState) { restored = s; },
    snapshot() {
      return {
        feedId: 'binance.spot', venueId: 'paper',
        symbolA: pair.symbolA, symbolB: pair.symbolB, beta: pair.beta ?? 1,
        lastZ: 1.1, regime: 'FLAT', barsSeen: ticks,
        capitalUnits: capital.toString(),
        equityUnits: (capital + 50n * M).toString(),   // each book "up" 50 USDC
        realisedPnlUnits: (50n * M).toString(),
        unrealisedPnlUnits: '0',
        openPosition: null,
      };
    },
  } as unknown as LivePaperTrader;
}

describe('LivePortfolioTrader', () => {
  function build() {
    const created: PortfolioPair[] = [];
    const factory = (p: PortfolioPair) => { created.push(p); return fakeTrader(p); };
    return { created, pt: new LivePortfolioTrader(factory, 10, 100n * M) };
  }

  it('splits capital evenly across pairs and aggregates the snapshot', () => {
    const { pt } = build();
    pt.setPairs(
      [{ symbolA: 'ETH', symbolB: 'BTC' }, { symbolA: 'SOL', symbolB: 'AVAX' }, { symbolA: 'AAVE', symbolB: 'UNI' }],
      300n * M,
    );
    const s = pt.snapshot();
    expect(s.pairCount).toBe(3);
    expect(s.capitalUnits).toBe((300n * M).toString());        // 3 * 100
    expect(s.equityUnits).toBe((300n * M + 150n * M).toString()); // each +50
    expect(s.realisedPnlUnits).toBe((150n * M).toString());
    expect(s.books).toHaveLength(3);
    expect(s.books[0].capitalUnits).toBe((100n * M).toString());
  });

  it('dedupes duplicate pairs and drops A==B', () => {
    const { pt, created } = build();
    pt.setPairs(
      [{ symbolA: 'ETH', symbolB: 'BTC' }, { symbolA: 'ETH', symbolB: 'BTC' }, { symbolA: 'X', symbolB: 'X' }],
      100n * M,
    );
    expect(pt.snapshot().pairCount).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('tick fans out to every book', async () => {
    const { pt } = build();
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }, { symbolA: 'SOL', symbolB: 'AVAX' }], 200n * M);
    await pt.tick();
    await pt.tick();
    expect(pt.snapshot().books.every((b) => b.barsSeen === 2)).toBe(true);
  });

  it('addBook launches one extra book additively with its own capital', () => {
    const { pt } = build();
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }], 100n * M);
    pt.addBook({ symbolA: 'SOL', symbolB: 'AVAX', strategyId: 'ou-bertram' }, 40n * M);
    const s = pt.snapshot();
    expect(s.pairCount).toBe(2);
    expect(s.books.find((b) => b.pair === 'SOL/AVAX')?.capitalUnits).toBe((40n * M).toString());
    // existing book is untouched by the additive launch
    expect(s.books.find((b) => b.pair === 'ETH/BTC')?.capitalUnits).toBe((100n * M).toString());
  });

  it('addBook rejects identical legs and non-positive capital', () => {
    const { pt } = build();
    expect(() => pt.addBook({ symbolA: 'X', symbolB: 'X' }, 1n * M)).toThrow(/identical/);
    expect(() => pt.addBook({ symbolA: 'A', symbolB: 'B' }, 0n)).toThrow(/positive/);
  });

  it('setCapital re-splits across existing books', () => {
    const { pt } = build();
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }, { symbolA: 'SOL', symbolB: 'AVAX' }], 200n * M);
    pt.setCapital(400n * M);
    const s = pt.snapshot();
    expect(s.capitalUnits).toBe((400n * M).toString());
    expect(s.books[0].capitalUnits).toBe((200n * M).toString());
    expect(() => pt.setCapital(0n)).toThrow(/positive/);
  });

  it('start is a no-op with zero pairs; toggles running once pairs are set', () => {
    const { pt } = build();
    pt.start();
    expect(pt.isRunning()).toBe(false);
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }], 100n * M);
    pt.start();
    expect(pt.isRunning()).toBe(true);
    pt.stop();
    expect(pt.isRunning()).toBe(false);
  });

  it('emits launch / start / stop / remove business events to the desk-event sink', async () => {
    const sink = new CapturingSink();
    const factory = (p: PortfolioPair) => fakeTrader(p);
    const pt = new LivePortfolioTrader(factory, 10, 100n * M, sink);
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }], 100n * M); // 1 launch
    pt.addBook({ symbolA: 'SOL', symbolB: 'AVAX' }, 40n * M); // 1 launch
    pt.start(); // 1 start (desk-level)
    await pt.removeBook('SOL/AVAX'); // 1 remove
    pt.stop(); // 1 stop (desk-level)

    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toEqual(['launch', 'launch', 'start', 'remove', 'stop']);
    expect(sink.events.every((e) => e.desk === 'stat-arb')).toBe(true);
    expect(sink.events.find((e) => e.kind === 'remove')?.book).toBe('SOL/AVAX');
  });

  it('checkpoints books to the store on tick + soft-closes on remove', async () => {
    const store = new FakeStore();
    const pt = new LivePortfolioTrader((p) => fakeTrader(p), 10, 100n * M, undefined, { store });
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC', strategyId: 'bollinger-pairs', notionalUnits: 5n * M }], 100n * M);
    await pt.tick();
    expect(store.saved.length).toBeGreaterThan(0);
    const rec = store.saved[store.saved.length - 1];
    expect(rec.bookKey).toBe('ETH/BTC');
    expect(rec.notionalUnits).toBe(5n * M);
    expect(rec.strategyId).toBe('bollinger-pairs');

    await pt.removeBook('ETH/BTC');
    expect(store.closed).toContain('ETH/BTC');
  });

  it('falls back to the default notional when a launched pair omits its own', async () => {
    const store = new FakeStore();
    const pt = new LivePortfolioTrader((p) => fakeTrader(p), 10, 100n * M, undefined, { store, defaultNotionalUnits: 7n * M });
    pt.addBook({ symbolA: 'SOL', symbolB: 'AVAX' }, 40n * M); // no notionalUnits
    expect(store.saved[0].notionalUnits).toBe(7n * M);
  });

  it('rehydrates OPEN books from the store on bootstrap, restoring their state', async () => {
    const store = new FakeStore();
    store.open = [{
      bookKey: 'ETH/BTC', symbolA: 'ETH', symbolB: 'BTC', source: 'binance',
      strategyId: 'bollinger-pairs', beta: 0.85, params: null,
      notionalUnits: 5n * M, capitalUnits: 50n * M, running: true,
      state: { ...flatState(), realisedPnlUnits: '12000000', closedTradeCount: 4 },
    }];
    const created: PortfolioPair[] = [];
    const pt = new LivePortfolioTrader((p) => { created.push(p); return fakeTrader(p); }, 10, 100n * M, undefined, { store });
    await pt.onApplicationBootstrap();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ symbolA: 'ETH', symbolB: 'BTC', beta: 0.85, notionalUnits: 5n * M });
    expect(pt.snapshot().pairCount).toBe(1);
  });

  it('a Null/disabled store never checkpoints (in-memory only)', async () => {
    const store = new FakeStore();
    store.enabled = false;
    const pt = new LivePortfolioTrader((p) => fakeTrader(p), 10, 100n * M, undefined, { store });
    pt.setPairs([{ symbolA: 'ETH', symbolB: 'BTC' }], 100n * M);
    await pt.tick();
    expect(store.saved).toHaveLength(0);
  });

  it('empty snapshot reports the standalone capital anchor', () => {
    const { pt } = build();
    const s = pt.snapshot();
    expect(s.pairCount).toBe(0);
    expect(s.capitalUnits).toBe((100n * M).toString());
    expect(s.equityUnits).toBe((100n * M).toString());
  });
});
