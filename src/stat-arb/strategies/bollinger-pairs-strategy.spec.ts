import { BollingerPairsStrategy } from './bollinger-pairs-strategy';
import { BarContext } from '../backtest/strategy.interface';
import { Bar } from '../backtest/bar';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function barsFromSpread(spread: number[]): { a: Bar[]; b: Bar[] } {
  const base = Date.UTC(2026, 0, 1);
  const a: Bar[] = [];
  const b: Bar[] = [];
  for (let i = 0; i < spread.length; i++) {
    const ts = new Date(base + i * 60_000);
    const ac = 100 * Math.exp(spread[i]);
    a.push({ symbol: 'AAA', timestamp: ts, open: ac, high: ac, low: ac, close: ac, volume: 1 });
    b.push({ symbol: 'BBB', timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
  }
  return { a, b };
}

function run(strat: BollingerPairsStrategy, a: Bar[], b: Bar[]) {
  const orders: Array<{ i: number; reason: string }> = [];
  for (let i = 0; i < a.length; i++) {
    const ctx: BarContext = { a: a[i], b: b[i], index: i, historyA: a.slice(0, i + 1), historyB: b.slice(0, i + 1) };
    for (const o of strat.onBar(ctx)) orders.push({ i, reason: o.reason });
  }
  return orders;
}

describe('BollingerPairsStrategy', () => {
  it('opens on an EWMA-z breach and closes when the spread reverts to its mean', () => {
    const r = rng(11);
    // 70 noise bars, a 3-bar rich spike, then a flat-at-mean tail so |z| falls back inside exitZ.
    const spread: number[] = [];
    for (let i = 0; i < 70; i++) spread.push((r() - 0.5) * 2 * 0.003);
    for (let i = 0; i < 3; i++) spread.push(0.02);
    for (let i = 0; i < 30; i++) spread.push(0);

    const { a, b } = barsFromSpread(spread);
    const strat = new BollingerPairsStrategy({
      beta: 1, lambda: 0.9, warmupBars: 20, entryZ: 2, exitZ: 0.5, notionalUnits: 1_000_000n,
    });
    const orders = run(strat, a, b);

    expect(orders.some((o) => o.reason === 'OPEN_SHORT')).toBe(true);
    expect(orders.some((o) => o.reason === 'CLOSE')).toBe(true);
    // The open must precede its close.
    const firstOpen = orders.find((o) => o.reason.startsWith('OPEN'))!.i;
    const firstClose = orders.find((o) => o.reason === 'CLOSE')!.i;
    expect(firstClose).toBeGreaterThan(firstOpen);
  });

  it('does not trade before warm-up completes', () => {
    const spread = Array.from({ length: 10 }, () => 0.05); // big but pre-warmup
    const { a, b } = barsFromSpread(spread);
    const strat = new BollingerPairsStrategy({
      beta: 1, lambda: 0.9, warmupBars: 20, entryZ: 2, exitZ: 0.5, notionalUnits: 1_000_000n,
    });
    expect(run(strat, a, b).length).toBe(0);
  });

  it('reset() restores FLAT and NaN z', () => {
    const strat = new BollingerPairsStrategy({
      beta: 1.5, lambda: 0.9, warmupBars: 5, entryZ: 2, exitZ: 0.5, notionalUnits: 1_000_000n,
    });
    strat.reset();
    expect(strat.currentRegime()).toBe('FLAT');
    expect(Number.isNaN(strat.lastZ)).toBe(true);
    expect(strat.currentBeta()).toBe(1.5);
  });
});
