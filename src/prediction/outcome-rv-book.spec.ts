import { BinaryQuote } from './binary-market.types';
import { OutcomeRvBook, OutcomeRvConfig, RvDecision } from './outcome-rv-book';

const CFG: OutcomeRvConfig = {
  edgeMinProb: 0.03,
  settleFeeProb: 0.005,
  contractsPerTrade: 500,
  maxCollateralPerMarket: 500,
  maxTotalCollateral: 2000,
  minMinutesToExpiry: 45,
  takeProfitFrac: 0.7,
  maxTouchFrac: 0.5,
};

const NOW = Date.UTC(2026, 6, 13, 18, 0);
const EXPIRY = Date.UTC(2026, 6, 14, 6, 0); // 12h out

function quote(over: Partial<BinaryQuote> = {}): BinaryQuote {
  // The founding live read: YES 0.153/0.180, fair 0.1334.
  return {
    venue: 'hyperliquid-hip4',
    marketId: '823',
    underlying: 'BTC',
    targetPrice: 62814,
    expiryMs: EXPIRY,
    period: '1d',
    yesBid: 0.153,
    yesAsk: 0.18,
    yesBidSize: 1000,
    yesAskSize: 200,
    timeMs: NOW,
    ...over,
  };
}

describe('OutcomeRvBook.evaluate', () => {
  it('buys NO when the crowd bids YES above fair (the founding read, gate loosened to see the side pick)', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const d = book.evaluate(quote(), 0.1334, NOW) as RvDecision;
    expect(d.action).toBe('BUY_NO');
    // noEdge = yesBid − fair − fee = 0.153 − 0.1334 − 0.005
    expect(d.edge).toBeCloseTo(0.0146, 6);
    expect(d.execProb).toBeCloseTo(1 - 0.153, 9);
  });

  it('refuses the founding read at the pre-registered 3c gate (honest: spread edge alone is not enough)', () => {
    const book = new OutcomeRvBook(CFG);
    const d = book.evaluate(quote(), 0.1334, NOW);
    expect(d.action).toBeNull();
    if (d.action === null) expect(d.reason).toMatch(/edge/);
  });

  it('buys YES when the ask sits below fair by more than fee + gate', () => {
    const book = new OutcomeRvBook(CFG);
    const d = book.evaluate(quote({ yesAsk: 0.09, yesBid: 0.07 }), 0.1334, NOW) as RvDecision;
    expect(d.action).toBe('BUY_YES');
    expect(d.edge).toBeCloseTo(0.1334 - 0.09 - 0.005, 9);
    expect(d.execProb).toBe(0.09);
  });

  it('fee adjustment can flip a raw edge below the gate', () => {
    const feeHeavy = new OutcomeRvBook({ ...CFG, settleFeeProb: 0.05 });
    const d = feeHeavy.evaluate(quote({ yesAsk: 0.09 }), 0.1334, NOW);
    expect(d.action).toBeNull();
  });

  it('refuses entries inside the expiry guard', () => {
    const book = new OutcomeRvBook(CFG);
    const nearExpiry = EXPIRY - 30 * 60_000;
    const d = book.evaluate(quote({ yesAsk: 0.05 }), 0.1334, nearExpiry);
    expect(d.action).toBeNull();
    if (d.action === null) expect(d.reason).toMatch(/expiry-guard/);
  });

  it('one position per market', () => {
    const book = new OutcomeRvBook(CFG);
    const q = quote({ yesAsk: 0.09 });
    const d = book.evaluate(q, 0.1334, NOW) as RvDecision;
    book.enter(q, d, 0.1334, NOW);
    const again = book.evaluate(q, 0.1334, NOW);
    expect(again.action).toBeNull();
    if (again.action === null) expect(again.reason).toBe('position-open');
  });

  it('clamps size to touch fraction and collateral caps', () => {
    const book = new OutcomeRvBook({ ...CFG, contractsPerTrade: 10_000, maxCollateralPerMarket: 90 });
    const q = quote({ yesAsk: 0.09, yesAskSize: 400 });
    const d = book.evaluate(q, 0.1334, NOW) as RvDecision;
    // touch cap: 400 × 0.5 = 200; collateral cap: 90 / 0.09 = 1000 → touch binds
    expect(d.contracts).toBe(200);
    const tiny = new OutcomeRvBook({ ...CFG, contractsPerTrade: 10_000, maxCollateralPerMarket: 9 });
    const d2 = tiny.evaluate(q, 0.1334, NOW) as RvDecision;
    expect(d2.contracts).toBe(100); // 9 / 0.09
  });
});

describe('OutcomeRvBook settlement + realised accounting', () => {
  it('settles a winning NO: realised = contracts − collateral − fee', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const q = quote(); // BUY_NO at 0.847
    const d = book.evaluate(q, 0.1334, NOW) as RvDecision;
    const pos = book.enter(q, d, 0.1334, NOW);
    const settled = book.settle('823', false, EXPIRY)!; // YES loses → NO wins
    expect(settled.realised).toBeCloseTo(pos.contracts - pos.collateral - 0.005 * pos.contracts, 6);
    expect(book.snapshot().wins).toBe(1);
    expect(book.snapshot().realisedTotal).toBeCloseTo(settled.realised!, 9);
  });

  it('settles a losing NO: realised = −collateral − fee (max loss known at entry)', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const q = quote();
    const d = book.evaluate(q, 0.1334, NOW) as RvDecision;
    const pos = book.enter(q, d, 0.1334, NOW);
    const settled = book.settle('823', true, EXPIRY)!;
    expect(settled.realised).toBeCloseTo(-pos.collateral - 0.005 * pos.contracts, 6);
    expect(book.snapshot().losses).toBe(1);
  });

  it('take-profit closes early when the market pays ≥ 70% of entry edge', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const q = quote(); // BUY_NO at 1 − 0.153 = 0.847, edge 0.0146
    const d = book.evaluate(q, 0.1334, NOW) as RvDecision;
    book.enter(q, d, 0.1334, NOW);
    // YES collapses: NO now sells at 1 − yesAsk = 0.90 → locked = 0.90 − 0.847 − 0.005 = 0.048 ≥ 0.7×0.0146
    const closed = book.tryTakeProfit(quote({ yesBid: 0.08, yesAsk: 0.10 }), NOW + 3_600_000)!;
    expect(closed).not.toBeNull();
    expect(closed.realised).toBeCloseTo((0.9 - d.execProb - 0.005) * d.contracts, 6);
    expect(book.snapshot().closedEarly).toBe(1);
    expect(book.collateralLocked()).toBe(0);
  });

  it('take-profit does NOT fire for less than the locked fraction', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const q = quote();
    book.enter(q, book.evaluate(q, 0.1334, NOW) as RvDecision, 0.1334, NOW);
    expect(book.tryTakeProfit(quote({ yesBid: 0.15, yesAsk: 0.152 }), NOW + 1000)).toBeNull();
  });

  it('expiredOpen lists open positions past expiry for the runner to settle', () => {
    const book = new OutcomeRvBook({ ...CFG, edgeMinProb: 0.01 });
    const q = quote();
    book.enter(q, book.evaluate(q, 0.1334, NOW) as RvDecision, 0.1334, NOW);
    expect(book.expiredOpen(NOW).length).toBe(0);
    expect(book.expiredOpen(EXPIRY + 1).length).toBe(1);
  });
});
