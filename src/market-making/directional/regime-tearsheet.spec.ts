import { computeTearsheet, EquityPoint, BenchPoint } from './regime-tearsheet';

const curve = (eq: number[]): EquityPoint[] => eq.map((equityUsd, i) => ({ tMs: i * 3_600_000, equityUsd }));
const bench = (px: number[]): BenchPoint[] => px.map((price, i) => ({ tMs: i * 3_600_000, price }));

describe('computeTearsheet (P14)', () => {
  it('computes total return as Δequity / capital', () => {
    const t = computeTearsheet({ curve: curve([0, 1000, 2000, 3000]), benchmark: bench([100, 100, 100, 100]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.totalReturnPct).toBeCloseTo(3, 9); // 3000 / 100k = 3%
    expect(t.finalEquityUsd).toBe(3000);
  });

  it('computes maxDD% and its underwater duration from the curve', () => {
    // peak at 2000 (idx2), trough 500 (idx4), recover later ⇒ DD 1500 over capital, dur ≥ 2 bars.
    const t = computeTearsheet({ curve: curve([0, 1000, 2000, 1200, 500, 1800]), benchmark: bench([1, 1, 1, 1, 1, 1]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.maxDrawdownPct).toBeCloseTo(1.5, 9); // (2000−500)/100k
    expect(t.maxDrawdownDurationBars).toBeGreaterThanOrEqual(2);
  });

  it('annualises Sharpe and gives a positive Sortino on a mostly-up curve (with a dip)', () => {
    // one down bar (250→200) so downside deviation is defined; net trend up ⇒ both positive.
    const t = computeTearsheet({ curve: curve([0, 100, 250, 200, 500, 640]), benchmark: bench([1, 1, 1, 1, 1, 1]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.sharpe).toBeGreaterThan(0);
    expect(t.sortino).toBeGreaterThan(0);
  });

  it('Sortino is 0 (undefined) when there are no losing bars', () => {
    const t = computeTearsheet({ curve: curve([0, 100, 250, 360, 500]), benchmark: bench([1, 1, 1, 1, 1]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.sortino).toBe(0); // no downside deviation ⇒ undefined, reported as 0
  });

  it('is benchmark-relative: excess return, beta, correlation vs BTC', () => {
    // desk equity flat (0 return), benchmark BTC +20% ⇒ excess −20pp.
    const t = computeTearsheet({ curve: curve([0, 0, 0, 0]), benchmark: bench([100, 110, 115, 120]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.benchmark.totalReturnPct).toBeCloseTo(20, 6);
    expect(t.benchmark.excessReturnPct).toBeCloseTo(-20, 6);
  });

  it('recovers beta ≈ k when the desk return is k× the benchmark return', () => {
    // desk Δequity/cap = 2 × bench return each bar ⇒ beta ≈ 2, correlation ≈ 1.
    const benchPx = [100, 101, 103, 102, 105];
    const capital = 100_000;
    const eq = [0];
    for (let i = 1; i < benchPx.length; i++) {
      const r = (benchPx[i] - benchPx[i - 1]) / benchPx[i - 1];
      eq.push(eq[i - 1] + 2 * r * capital);
    }
    const t = computeTearsheet({ curve: curve(eq), benchmark: bench(benchPx), capitalUsd: capital, barsPerYear: 8760 });
    expect(t.benchmark.beta).toBeCloseTo(2, 6);
    expect(t.benchmark.correlation).toBeCloseTo(1, 6);
  });

  it('computes hit rate, avg win/loss and payoff from per-trade P&L', () => {
    const t = computeTearsheet({ curve: curve([0, 100]), benchmark: bench([1, 1]), capitalUsd: 100_000, barsPerYear: 8760, perTradePnlUsd: [120, -40, 80, -20] });
    expect(t.hitRate).toBeCloseTo(0.5, 9);
    expect(t.avgWinUsd).toBeCloseTo(100, 9); // (120+80)/2
    expect(t.avgLossUsd).toBeCloseTo(-30, 9); // (−40−20)/2
    expect(t.payoffRatio).toBeCloseTo(100 / 30, 6);
  });

  it('handles a flat / degenerate curve without NaN', () => {
    const t = computeTearsheet({ curve: curve([0, 0, 0]), benchmark: bench([100, 100, 100]), capitalUsd: 100_000, barsPerYear: 8760 });
    expect(t.sharpe).toBe(0);
    expect(t.sortino).toBe(0);
    expect(t.maxDrawdownPct).toBe(0);
    expect(Number.isNaN(t.benchmark.beta)).toBe(false);
  });
});
