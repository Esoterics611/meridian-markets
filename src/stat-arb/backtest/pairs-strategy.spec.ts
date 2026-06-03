import { PairsStrategy } from './pairs-strategy';
import { BarContext } from './strategy.interface';
import { Bar } from './bar';

// Focused spec for β-weighted dollar-neutral sizing (course §10.3). The rest of
// PairsStrategy's entry/exit logic is exercised via the backtest + registry specs.

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// A = 100·e^spread, B = 100. The strategy's log-spread is mean-centred by the
// z-score, so a constant β offset doesn't change WHEN it trades — only the sizing.
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

interface Cap { symbol: string; side: string; notionalUnits: bigint; reason: string; }
function run(strat: PairsStrategy, a: Bar[], b: Bar[]): Cap[] {
  const out: Cap[] = [];
  for (let i = 0; i < a.length; i++) {
    const ctx: BarContext = { a: a[i], b: b[i], index: i, historyA: a.slice(0, i + 1), historyB: b.slice(0, i + 1) };
    for (const o of strat.onBar(ctx)) out.push({ symbol: o.symbol, side: o.side, notionalUnits: o.notionalUnits, reason: o.reason });
  }
  return out;
}

// 40 quiet bars, a 3-bar negative dip (z ≪ −entryZ ⇒ LONG: buy A / sell B), then
// a flat-at-mean tail so |z| < exitZ and the position closes.
function dipSpread(): number[] {
  const r = rng(7);
  const spread: number[] = [];
  for (let i = 0; i < 40; i++) spread.push((r() - 0.5) * 2 * 0.003);
  for (let i = 0; i < 3; i++) spread.push(-0.02);
  for (let i = 0; i < 30; i++) spread.push(0);
  return spread;
}

describe('PairsStrategy β-weighted sizing', () => {
  const n = 1_000_000n;

  it('scales the B leg to |β|·notional and closes with the SAME B notional as the open', () => {
    const { a, b } = barsFromSpread(dipSpread());
    const strat = new PairsStrategy({ beta: 2.0, zLookback: 20, entryZ: 2, exitZ: 0.5, notionalUnits: n, betaWeightedSizing: true });
    const orders = run(strat, a, b);

    const opens = orders.filter((o) => o.reason.startsWith('OPEN'));
    const closes = orders.filter((o) => o.reason === 'CLOSE');
    expect(opens.length).toBe(2);
    expect(closes.length).toBe(2);

    const openA = opens.find((o) => o.symbol === 'AAA')!;
    const openB = opens.find((o) => o.symbol === 'BBB')!;
    expect(openA.notionalUnits).toBe(n);           // A leg = notional
    expect(openB.notionalUnits).toBe(2_000_000n);  // B leg = |β|·notional

    const closeB = closes.find((o) => o.symbol === 'BBB')!;
    expect(closeB.notionalUnits).toBe(openB.notionalUnits); // exit matches entry
  });

  it('defaults to equal-dollar (both legs = notional) when β-weighting is off', () => {
    const { a, b } = barsFromSpread(dipSpread());
    const strat = new PairsStrategy({ beta: 2.0, zLookback: 20, entryZ: 2, exitZ: 0.5, notionalUnits: n });
    const opens = run(strat, a, b).filter((o) => o.reason.startsWith('OPEN'));
    expect(opens.find((o) => o.symbol === 'AAA')!.notionalUnits).toBe(n);
    expect(opens.find((o) => o.symbol === 'BBB')!.notionalUnits).toBe(n); // β ignored in sizing
  });

  it('clamps a pathological β to the sizing bounds', () => {
    const { a, b } = barsFromSpread(dipSpread());
    const strat = new PairsStrategy({ beta: 50, zLookback: 20, entryZ: 2, exitZ: 0.5, notionalUnits: n, betaWeightedSizing: true });
    const openB = run(strat, a, b).find((o) => o.reason.startsWith('OPEN') && o.symbol === 'BBB')!;
    expect(openB.notionalUnits).toBe(4_000_000n); // clamped to BETA_SIZE_MAX=4 × n
  });
});
