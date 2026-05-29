import { OuSpreadStrategy } from './ou-spread-strategy';
import { BarContext } from '../backtest/strategy.interface';
import { Bar } from '../backtest/bar';

// Deterministic LCG so the "noise" is reproducible across runs.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Build a price pair whose log-spread (β=1, B≡100) equals the given series.
function barsFromSpread(spread: number[]): { a: Bar[]; b: Bar[] } {
  const base = Date.UTC(2026, 0, 1);
  const a: Bar[] = [];
  const b: Bar[] = [];
  for (let i = 0; i < spread.length; i++) {
    const ts = new Date(base + i * 60_000);
    const bc = 100;
    const ac = 100 * Math.exp(spread[i]);
    a.push({ symbol: 'AAA', timestamp: ts, open: ac, high: ac, low: ac, close: ac, volume: 1 });
    b.push({ symbol: 'BBB', timestamp: ts, open: bc, high: bc, low: bc, close: bc, volume: 1 });
  }
  return { a, b };
}

function run(strat: OuSpreadStrategy, a: Bar[], b: Bar[]) {
  const orders: Array<{ i: number; reason: string }> = [];
  for (let i = 0; i < a.length; i++) {
    const ctx: BarContext = { a: a[i], b: b[i], index: i, historyA: a.slice(0, i + 1), historyB: b.slice(0, i + 1) };
    for (const o of strat.onBar(ctx)) orders.push({ i, reason: o.reason });
  }
  return orders;
}

describe('OuSpreadStrategy', () => {
  it('opens SHORT on a band-breaching rich deviation in a mean-reverting spread', () => {
    const r = rng(7);
    const n = 100, spikeAt = 70, spikeLen = 3;
    const spread: number[] = [];
    for (let i = 0; i < n; i++) {
      const noise = (r() - 0.5) * 2 * 0.002; // small noise, kept below the band
      spread.push(i >= spikeAt && i < spikeAt + spikeLen ? 0.02 + noise : noise);
    }
    const { a, b } = barsFromSpread(spread);
    // Wide Bertram band (high txCost) so only the +2% spike — not the noise — breaches it.
    const strat = new OuSpreadStrategy({ beta: 1, ouWindow: 40, txCostFraction: 0.05, notionalUnits: 1_000_000n });
    const orders = run(strat, a, b);

    const opens = orders.filter((o) => o.reason === 'OPEN_SHORT' || o.reason === 'OPEN_LONG');
    expect(opens.length).toBeGreaterThan(0);
    expect(opens[0].reason).toBe('OPEN_SHORT'); // spread rich → sell A / buy B
    expect(Number.isFinite(strat.lastZ)).toBe(true);
  });

  it('stands aside on a trending (non-mean-reverting) spread and logs NOT_MEAN_REVERTING', () => {
    const n = 80;
    const spread = Array.from({ length: n }, (_, i) => i * 0.001); // monotone ramp → θ≈0
    const { a, b } = barsFromSpread(spread);
    const strat = new OuSpreadStrategy({ beta: 1, ouWindow: 40, txCostFraction: 0.0002, notionalUnits: 1_000_000n });
    const orders = run(strat, a, b);

    expect(orders.filter((o) => o.reason !== 'CLOSE').length).toBe(0);
    expect(strat.gateLog().some((g) => g.kind === 'NOT_MEAN_REVERTING')).toBe(true);
  });

  it('rollbackEntry() and reset() restore FLAT', () => {
    const strat = new OuSpreadStrategy({ beta: 1, ouWindow: 10, txCostFraction: 0.0002, notionalUnits: 1_000_000n });
    strat.rollbackEntry();
    expect(strat.currentRegime()).toBe('FLAT');
    strat.reset();
    expect(strat.currentRegime()).toBe('FLAT');
    expect(Number.isNaN(strat.lastZ)).toBe(true);
    expect(strat.currentBeta()).toBe(1);
  });
});
