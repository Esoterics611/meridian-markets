import {
  aggregatePortfolioRisk,
  betaPnlIncrementUnits,
  sampleStdev,
  Z95,
  Z99,
  BookRiskRead,
} from './regime-portfolio-risk';

const U = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000));

describe('RegimePortfolioRisk (P10)', () => {
  describe('sampleStdev', () => {
    it('is 0 for fewer than two points', () => {
      expect(sampleStdev([])).toBe(0);
      expect(sampleStdev([0.01])).toBe(0);
    });
    it('matches the n−1 sample stdev', () => {
      // [1,2,3,4,5] mean 3, ss = 10, /(5−1)=2.5, sqrt=1.5811…
      expect(sampleStdev([1, 2, 3, 4, 5])).toBeCloseTo(1.5811388, 6);
    });
  });

  describe('exposure aggregation', () => {
    it('sums gross, net, and net-beta exposure', () => {
      const books: BookRiskRead[] = [
        { symbol: 'ETH', signedNotionalUsd: 50_000, beta: 1.2, returns: [] },
        { symbol: 'SOL', signedNotionalUsd: -30_000, beta: 1.5, returns: [] },
      ];
      const r = aggregatePortfolioRisk(books, [], { capitalUsd: 200_000 });
      expect(r.grossUsd).toBe(80_000);
      expect(r.netUsd).toBe(20_000);
      // 50k·1.2 + (−30k)·1.5 = 60k − 45k = 15k
      expect(r.netBetaUsd).toBe(15_000);
    });

    it('is all zeros for an empty (flat) desk', () => {
      const r = aggregatePortfolioRisk([], [0.01, -0.02, 0.005], { capitalUsd: 100_000 });
      expect(r.grossUsd).toBe(0);
      expect(r.netBetaUsd).toBe(0);
      expect(r.deskVolUsd).toBe(0);
      expect(r.var95Usd).toBe(0);
      expect(r.var95FracOfCapital).toBe(0);
    });
  });

  describe('single-factor vol decomposition', () => {
    const market = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005]; // σ_m known

    it('a position with beta·σ_m == σ_i has ZERO idiosyncratic vol (all factor)', () => {
      const sigmaM = sampleStdev(market);
      // Construct a return series whose stdev equals beta·σ_m exactly, so idioVar floors to 0.
      const beta = 2;
      const target = beta * sigmaM;
      // scale the market series by (target/σ_m) = beta ⇒ stdev = beta·σ_m.
      const returns = market.map((x) => x * beta);
      expect(sampleStdev(returns)).toBeCloseTo(target, 12);
      const r = aggregatePortfolioRisk([{ symbol: 'X', signedNotionalUsd: 10_000, beta, returns }], market, { capitalUsd: 100_000 });
      expect(r.idioVolUsd).toBeCloseTo(0, 6);
      expect(r.factorVolUsd).toBeCloseTo(10_000 * beta * sigmaM, 6);
      expect(r.deskVolUsd).toBeCloseTo(r.factorVolUsd, 6);
    });

    it('a beta-0 book is ALL idiosyncratic (no factor risk)', () => {
      const returns = [0.03, -0.01, 0.02, -0.04, 0.01];
      const r = aggregatePortfolioRisk([{ symbol: 'X', signedNotionalUsd: 10_000, beta: 0, returns }], market, { capitalUsd: 100_000 });
      expect(r.factorVolUsd).toBe(0);
      expect(r.netBetaUsd).toBe(0);
      expect(r.idioVolUsd).toBeCloseTo(10_000 * sampleStdev(returns), 6);
    });

    it('factor risk does NOT diversify (common) but idio risk DOES (independent)', () => {
      // Two equal, opposite-sign books with the same beta magnitude but opposite sign:
      // net beta cancels (factor → 0) while idiosyncratic variances ADD.
      const ret = market.map((x) => x * 1.5 + 0.001);
      const books: BookRiskRead[] = [
        { symbol: 'A', signedNotionalUsd: 10_000, beta: 1, returns: ret },
        { symbol: 'B', signedNotionalUsd: -10_000, beta: 1, returns: ret },
      ];
      const r = aggregatePortfolioRisk(books, market, { capitalUsd: 100_000 });
      expect(r.netBetaUsd).toBe(0);
      expect(r.factorVolUsd).toBe(0);
      expect(r.idioVolUsd).toBeGreaterThan(0); // the idio pieces did not cancel
    });
  });

  describe('parametric VaR', () => {
    const market = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005];
    const books: BookRiskRead[] = [{ symbol: 'X', signedNotionalUsd: 25_000, beta: 1.1, returns: [0.02, -0.01, 0.03, -0.02, 0.01] }];

    it('scales VaR by the z-score (99% > 95% by exactly Z99/Z95)', () => {
      const r = aggregatePortfolioRisk(books, market, { capitalUsd: 100_000 });
      expect(r.var95Usd).toBeCloseTo(Z95 * r.deskVolUsd, 9);
      expect(r.var99Usd).toBeCloseTo(Z99 * r.deskVolUsd, 9);
      expect(r.var99Usd / r.var95Usd).toBeCloseTo(Z99 / Z95, 9);
    });

    it('scales VaR by √horizon', () => {
      const r1 = aggregatePortfolioRisk(books, market, { capitalUsd: 100_000, horizonBars: 1 });
      const r4 = aggregatePortfolioRisk(books, market, { capitalUsd: 100_000, horizonBars: 4 });
      expect(r4.var95Usd / r1.var95Usd).toBeCloseTo(2, 9); // √4 = 2
    });

    it('reports VaR as a fraction of capital (the heat)', () => {
      const r = aggregatePortfolioRisk(books, market, { capitalUsd: 100_000 });
      expect(r.var95FracOfCapital).toBeCloseTo(r.var95Usd / 100_000, 12);
    });

    it('is 0 when the market and symbols have zero realised vol', () => {
      const flat = [0, 0, 0, 0];
      const r = aggregatePortfolioRisk([{ symbol: 'X', signedNotionalUsd: 10_000, beta: 1, returns: flat }], flat, { capitalUsd: 100_000 });
      expect(r.deskVolUsd).toBe(0);
      expect(r.var95Usd).toBe(0);
    });
  });

  describe('betaPnlIncrementUnits', () => {
    it('is signedNotional·β·marketReturn in USDC-units', () => {
      // 50,000 USD long, β 1.2, market +1% ⇒ 50000·1.2·0.01 = 600 USD
      expect(betaPnlIncrementUnits(50_000, 1.2, 0.01)).toBe(U(600));
    });
    it('a short loses beta P&L when the market rises', () => {
      expect(betaPnlIncrementUnits(-50_000, 1.2, 0.01)).toBe(U(-600));
    });
    it('is 0 for a flat position or a non-finite input', () => {
      expect(betaPnlIncrementUnits(0, 1.2, 0.01)).toBe(0n);
      expect(betaPnlIncrementUnits(50_000, NaN, 0.01)).toBe(0n);
      expect(betaPnlIncrementUnits(50_000, 1, Infinity)).toBe(0n);
    });
  });
});
