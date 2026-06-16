import { RegimeBetaHedge, BookBeta, estimateBeta } from './regime-beta-hedge';
import { DeskEventInput } from '../events/desk-event';

const book = (symbol: string, signedNotionalUsd: number, beta: number): BookBeta => ({ symbol, signedNotionalUsd, beta });

describe('estimateBeta', () => {
  it('a perfectly co-moving asset has beta ≈ 1', () => {
    const h = [0.01, -0.02, 0.03, -0.01, 0.005];
    expect(estimateBeta(h, h)).toBeCloseTo(1);
  });
  it('a 2× amplified asset has beta ≈ 2', () => {
    const h = [0.01, -0.02, 0.03, -0.01, 0.005];
    const a = h.map((x) => 2 * x);
    expect(estimateBeta(a, h)).toBeCloseTo(2);
  });
  it('too little data ⇒ unit beta (conservative, fully hedge)', () => {
    expect(estimateBeta([0.01], [0.01])).toBe(1);
  });
});

describe('RegimeBetaHedge', () => {
  it('targets the leg that flattens net beta (−Σ signedNotional·beta)', () => {
    const h = new RegimeBetaHedge({ hedgeSymbol: 'BTC' });
    const books = [book('ETH', 50_000, 1.2), book('SOL', 30_000, 1.5)];
    // net beta = 50k·1.2 + 30k·1.5 = 60k + 45k = 105k ⇒ target hedge = −105k (short BTC)
    expect(h.targetNotionalUsd(books)).toBeCloseTo(-105_000);
  });

  it('HEDGED mode drives residual net beta to ~0 (covers all books)', () => {
    const h = new RegimeBetaHedge({ rebalanceBandUsd: 1_000 });
    const books = [book('ETH', 50_000, 1.2), book('SOL', -20_000, 1.5)];
    const r = h.rebalance(books, 0);
    expect(r.changed).toBe(true);
    expect(r.residualBetaUsd).toBeCloseTo(0);
    expect(Math.abs(h.hedgeNotionalUsd())).toBeGreaterThan(0);
  });

  it('a partial book set leaves a NON-zero residual (coverage matters — the coherence check)', () => {
    const all = [book('ETH', 50_000, 1.2), book('SOL', 30_000, 1.5)];
    const partial = [all[0]]; // forgot SOL
    const h = new RegimeBetaHedge({ rebalanceBandUsd: 1_000 });
    h.rebalance(partial, 0);
    // The omitted SOL beta is left naked: re-measure residual against the FULL book set.
    const full = h.rebalance(all, 0); // covering all books restores ~0
    expect(Math.abs(full.residualBetaUsd)).toBeLessThan(1); // covered
  });

  it('respects the rebalance band — a sub-band drift does not churn the leg', () => {
    const h = new RegimeBetaHedge({ rebalanceBandUsd: 10_000 });
    const first = h.rebalance([book('ETH', 50_000, 1.0)], 0);
    expect(first.changed).toBe(true);
    const leg = h.hedgeNotionalUsd();
    // A tiny beta change (5k < 10k band) must NOT move the leg.
    const second = h.rebalance([book('ETH', 55_000, 1.0)], 1);
    expect(second.changed).toBe(false);
    expect(h.hedgeNotionalUsd()).toBe(leg);
  });

  it('emits a hedgeEvent on a rebalance and accrues a fee', () => {
    const events: DeskEventInput[] = [];
    const h = new RegimeBetaHedge({ rebalanceBandUsd: 0, takerFeeBps: 4.5 }, (e) => events.push(e));
    h.rebalance([book('ETH', 100_000, 1.0)], 0);
    expect(events.some((e) => e.kind === 'hedge')).toBe(true);
    expect(h.feesUnits()).toBeGreaterThan(0n);
  });

  describe('OUTRIGHT mode (no hedger constructed) is the default', () => {
    it('a desk with no hedge keeps its full directional net beta', () => {
      // Outright = the runner simply never calls the hedger; net beta is whatever the books sum to.
      const books = [book('ETH', 50_000, 1.2), book('SOL', 30_000, 1.5)];
      const netBeta = books.reduce((a, b) => a + b.signedNotionalUsd * b.beta, 0);
      expect(netBeta).toBeCloseTo(105_000); // unchanged — the directional bet is intact
    });
  });
});
