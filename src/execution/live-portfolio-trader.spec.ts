import { LivePortfolioTrader, PortfolioPair } from './live-portfolio-trader';
import { LivePaperTrader } from './live-paper-trader';

const M = 1_000_000n;

// Minimal fake sub-trader: the portfolio only calls setStartingCapital / tick /
// snapshot on each book, so we stub exactly those.
function fakeTrader(pair: PortfolioPair) {
  let capital = 0n;
  let ticks = 0;
  return {
    _capital: () => capital,
    _ticks: () => ticks,
    setStartingCapital(u: bigint) { capital = u; },
    async tick() { ticks += 1; },
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

  it('empty snapshot reports the standalone capital anchor', () => {
    const { pt } = build();
    const s = pt.snapshot();
    expect(s.pairCount).toBe(0);
    expect(s.capitalUnits).toBe((100n * M).toString());
    expect(s.equityUnits).toBe((100n * M).toString());
  });
});
