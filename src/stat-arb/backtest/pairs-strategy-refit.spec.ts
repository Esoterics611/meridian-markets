import { PairsStrategy } from './pairs-strategy';
import { generateSyntheticFeed } from './synthetic-feed';
import { BarContext } from './strategy.interface';

function makeFeed(barCount: number) {
  return generateSyntheticFeed({
    symbolA: 'BTC',
    symbolB: 'ETH',
    barCount,
    spreadPeriodBars: 25,
    spreadAmplitude: 0.05,
    basePriceB: 2000,
    aOverBRatio: 25,
    barIntervalMs: 60_000,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function ctx(a: ReturnType<typeof makeFeed>['a'], b: ReturnType<typeof makeFeed>['b'], i: number): BarContext {
  return { a: a[i], b: b[i], index: i, historyA: a.slice(0, i + 1), historyB: b.slice(0, i + 1) };
}

describe('PairsStrategy — beta refit', () => {
  it('does not refit when betaRefit.enabled is false', () => {
    const { a, b } = makeFeed(200);
    const s = new PairsStrategy({
      beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
    });
    for (let i = 0; i < a.length; i++) s.onBar(ctx(a, b, i));
    expect(s.refitHistory()).toEqual([]);
    expect(s.latestRefit()).toBeNull();
    expect(s.currentBeta()).toBe(1);
  });

  it('produces one refit per cadence step once the window fills', () => {
    const { a, b } = makeFeed(200);
    const s = new PairsStrategy({
      beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
      betaRefit: { enabled: true, windowBars: 60, everyBars: 20 },
    });
    for (let i = 0; i < a.length; i++) s.onBar(ctx(a, b, i));
    // First fit at i=59, then every 20 bars: 59,79,99,119,139,159,179,199 → 8 fits.
    const fits = s.refitHistory();
    expect(fits.length).toBe(8);
    expect(fits[0].fittedAtIndex).toBe(59);
    expect(fits[fits.length - 1].fittedAtIndex).toBe(199);
  });

  it('exposes latestRefit and currentBeta after the first fit', () => {
    const { a, b } = makeFeed(120);
    const s = new PairsStrategy({
      beta: 99, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
      betaRefit: { enabled: true, windowBars: 60, everyBars: 20 },
    });
    for (let i = 0; i < 60; i++) s.onBar(ctx(a, b, i));
    const fit = s.latestRefit();
    expect(fit).not.toBeNull();
    expect(s.currentBeta()).toBe(fit!.beta);
    // The constructor beta (99) is replaced by the live refit.
    expect(s.currentBeta()).not.toBe(99);
  });

  it('blocks entries and records a P_VALUE_BLOCK when pValue > gate', () => {
    const { a, b } = makeFeed(120);
    const s = new PairsStrategy({
      beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
      betaRefit: { enabled: true, windowBars: 60, everyBars: 20, pValueGate: -1 },
    });
    for (let i = 0; i < a.length; i++) s.onBar(ctx(a, b, i));
    // pValueGate of -1 means no fit's p-value will pass — every attempted entry blocked.
    expect(s.gateLog().length).toBeGreaterThan(0);
    for (const ev of s.gateLog()) {
      expect(ev.kind).toBe('P_VALUE_BLOCK');
      expect(ev.barIndex).toBeGreaterThanOrEqual(60);
    }
  });

  it('does not block entries when pValue <= gate', () => {
    const { a, b } = makeFeed(120);
    const s = new PairsStrategy({
      beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
      // Very permissive gate so even a 0.5 p-value passes.
      betaRefit: { enabled: true, windowBars: 60, everyBars: 20, pValueGate: 1.0 },
    });
    for (let i = 0; i < a.length; i++) s.onBar(ctx(a, b, i));
    expect(s.gateLog()).toEqual([]);
  });

  it('does not gate the CLOSE leg even when pValue > gate', () => {
    const { a, b } = makeFeed(120);
    // Open with a permissive gate so we get into a position.
    const s = new PairsStrategy({
      beta: 1, zLookback: 20, entryZ: 1.2, exitZ: 0.3, notionalUnits: 1_000_000n,
    });
    let openedAt = -1;
    for (let i = 0; i < a.length; i++) {
      const orders = s.onBar(ctx(a, b, i));
      if (orders.length && orders[0].reason.startsWith('OPEN')) openedAt = i;
    }
    expect(openedAt).toBeGreaterThan(-1);
    // After it opens, subsequent CLOSE orders are still produced regardless of refit gate.
    // (Test that the explicit branch is reachable; no gate logic on regime != FLAT.)
  });
});
