import { replayRegimeBook, BacktestBar, SignalAt } from './regime-backtest';
import { RegimeDirectionalConfig } from './regime-directional-book';
import { BiasReading } from '../bias/bias-source.interface';

const cfg = (over: Partial<RegimeDirectionalConfig> = {}): RegimeDirectionalConfig => ({
  baseNotionalUsd: 50_000,
  bEnter: 0.15,
  bExit: 0.07,
  stopFrac: 0.02,
  takerFeeBps: 4.5,
  ...over,
});

const bullish: BiasReading = { bias: 0.5, validated: true, reason: 'bull' };
const alwaysBull: SignalAt = () => ({ reading: bullish });

/** A bar series at a constant per-step log drift. */
function drift(n: number, start: number, perStepRet: number): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    bars.push({ tMs: i * 3_600_000, close: p });
    p *= 1 + perStepRet;
  }
  return bars;
}

describe('replayRegimeBook (P8 book-level backtest)', () => {
  describe('no look-ahead (structural)', () => {
    it('the signal callback only ever sees bars up to and including the current index', () => {
      const bars = drift(20, 100, 0.001);
      let maxLenSeen = 0;
      const spy: SignalAt = (i, window) => {
        expect(window.length).toBe(i + 1); // window is exactly bars[0..i]
        expect(window[window.length - 1]).toBe(bars[i]); // last element IS the current bar
        maxLenSeen = Math.max(maxLenSeen, window.length);
        return { reading: bullish };
      };
      replayRegimeBook(bars, cfg(), spy);
      expect(maxLenSeen).toBe(20);
    });
  });

  describe('a known edge', () => {
    it('a persistent bullish view on a steadily RISING market makes realised money', () => {
      // Rising price + a held long, then a flat reading at the end to realise the gains.
      const bars = drift(40, 100, 0.003);
      const signal: SignalAt = (i) => ({ reading: i >= 38 ? { bias: 0, validated: true, reason: 'flat' } : bullish });
      const r = replayRegimeBook(bars, cfg(), signal);
      expect(r.entries).toBeGreaterThanOrEqual(1);
      expect(Number(r.realisedUnits)).toBeGreaterThan(0); // the edge survives the fees
      expect(r.stops).toBe(0); // a steady riser never trips the stop
    });
  });

  describe('a known stop', () => {
    it('a sharp adverse move while still bullish fires the directional stop and cuts the position', () => {
      // Up for a while (open a long), then a one-bar crash past the 2% stop.
      const up = drift(10, 100, 0.002);
      const last = up[up.length - 1].close;
      const crash: BacktestBar = { tMs: 10 * 3_600_000, close: last * 0.95 }; // −5% > 2% stop
      const bars = [...up, crash];
      const r = replayRegimeBook(bars, cfg(), alwaysBull);
      expect(r.entries).toBeGreaterThanOrEqual(1);
      expect(r.stops).toBeGreaterThanOrEqual(1); // the stop fired
      expect(Number(r.realisedUnits)).toBeLessThan(0); // a cut loss is realised, not ridden
    });
  });

  describe('scorecard fields', () => {
    it('reports exposure, hit rate, and a per-trade stream consistent with the closes', () => {
      const bars = drift(40, 100, 0.003);
      const signal: SignalAt = (i) => ({ reading: i >= 38 ? { bias: 0, validated: true, reason: 'flat' } : bullish });
      const r = replayRegimeBook(bars, cfg(), signal);
      expect(r.perTradePnlUsd.length).toBe(r.closes);
      expect(r.wins).toBeLessThanOrEqual(r.closes);
      expect(r.hitRate).toBeCloseTo(r.closes > 0 ? r.wins / r.closes : 0);
      expect(r.exposureFrac).toBeGreaterThan(0);
      expect(r.exposureFrac).toBeLessThanOrEqual(1);
    });

    it('an always-neutral signal trades nothing — flat, zero realised (the honest empty outcome)', () => {
      const bars = drift(30, 100, 0.002);
      const flat: SignalAt = () => ({ reading: { bias: 0, validated: true, reason: 'flat' } });
      const r = replayRegimeBook(bars, cfg(), flat);
      expect(r.entries).toBe(0);
      expect(r.realisedUnits).toBe(0n);
      expect(r.exposureFrac).toBe(0);
    });
  });
});
