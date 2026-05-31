import { PairsStrategy } from './pairs-strategy';
import { BarContext } from './strategy.interface';
import { Bar } from './bar';

// Build a price pair whose log-spread (β=1, B≡100) equals the given series.
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

function run(strat: PairsStrategy, a: Bar[], b: Bar[]) {
  const opens: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const ctx: BarContext = { a: a[i], b: b[i], index: i, historyA: a.slice(0, i + 1), historyB: b.slice(0, i + 1) };
    for (const o of strat.onBar(ctx)) if (o.reason !== 'CLOSE') opens.push(i);
  }
  return opens;
}

// A sine spread of amplitude 0.05 — a genuine, mean-reverting tradeable edge.
const SPREAD = Array.from({ length: 120 }, (_, i) => 0.05 * Math.sin((2 * Math.PI * i) / 25));
const cfg = { beta: 1, zLookback: 20, entryZ: 1.5, exitZ: 0.3, notionalUnits: 1_000_000n };

describe('PairsStrategy — fee-aware entry gate', () => {
  it('opens trades when the gate is off (fee-blind, prior behaviour)', () => {
    const { a, b } = barsFromSpread(SPREAD);
    expect(run(new PairsStrategy(cfg), a, b).length).toBeGreaterThan(0);
  });

  it('still opens the real-edge trades at a realistic 5 bps fee', () => {
    const { a, b } = barsFromSpread(SPREAD);
    expect(run(new PairsStrategy({ ...cfg, feeBps: 5, minEdgeMultiple: 1.5 }), a, b).length).toBeGreaterThan(0);
  });

  it('blocks every entry when the fee swamps the edge, logging FEE_GATE', () => {
    const { a, b } = barsFromSpread(SPREAD);
    const s = new PairsStrategy({ ...cfg, feeBps: 5000, minEdgeMultiple: 1 });
    expect(run(s, a, b).length).toBe(0);
    expect(s.gateLog().some((e) => e.kind === 'FEE_GATE')).toBe(true);
  });
});
