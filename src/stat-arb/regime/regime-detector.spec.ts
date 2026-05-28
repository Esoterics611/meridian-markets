import { detectRegime } from './regime-detector';

function logSeries(fn: (i: number) => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fn(i));
  return out;
}

describe('detectRegime — volatility', () => {
  it('classifies a calm mid-range series as NORMAL vol', () => {
    const s = logSeries((i) => 0.01 * Math.sin((2 * Math.PI * i) / 30), 200);
    const r = detectRegime(s);
    expect(r.vol).toBe('NORMAL');
  });

  it('classifies a flat tail of a previously-volatile series as LOW', () => {
    const s = logSeries(
      (i) => (i < 120 ? 0.05 * Math.sin((2 * Math.PI * i) / 5) : 0.001 * Math.sin((2 * Math.PI * i) / 30)),
      200,
    );
    const r = detectRegime(s, null, { lookbackBars: 40 });
    expect(r.vol).toBe('LOW');
  });

  it('classifies a sudden spike at the tail as HIGH', () => {
    const s = logSeries(
      (i) => (i < 120 ? 0.001 * Math.sin((2 * Math.PI * i) / 30) : 0.05 * Math.sin((2 * Math.PI * i) / 4)),
      200,
    );
    const r = detectRegime(s, null, { lookbackBars: 40 });
    expect(r.vol).toBe('HIGH');
  });

  it('realisedVol is non-negative', () => {
    const s = logSeries((i) => 0.01 * i, 200);
    const r = detectRegime(s);
    expect(r.realisedVol).toBeGreaterThanOrEqual(0);
  });
});

describe('detectRegime — trend', () => {
  it('classifies a steep uptrend as TRENDING', () => {
    const s = logSeries((i) => 0.005 * i, 200);
    const r = detectRegime(s);
    expect(r.trend).toBe('TRENDING');
    expect(r.trendSlope).toBeGreaterThan(0);
  });

  it('classifies a steep downtrend as TRENDING', () => {
    const s = logSeries((i) => -0.005 * i, 200);
    const r = detectRegime(s);
    expect(r.trend).toBe('TRENDING');
    expect(r.trendSlope).toBeLessThan(0);
  });

  it('classifies a flat oscillator as RANGE', () => {
    const s = logSeries((i) => 0.01 * Math.sin((2 * Math.PI * i) / 25), 200);
    const r = detectRegime(s);
    expect(r.trend).toBe('RANGE');
  });

  it('trendSlopeThreshold tunes sensitivity', () => {
    const s = logSeries((i) => 0.0005 * i, 200);
    const loose = detectRegime(s, null, { trendSlopeThreshold: 0.001 });
    const strict = detectRegime(s, null, { trendSlopeThreshold: 1.0 });
    expect(loose.trend).toBe('TRENDING');
    expect(strict.trend).toBe('RANGE');
  });
});

describe('detectRegime — decoupling', () => {
  it('mean-reverting pair flags decoupling=false', () => {
    // Strongly mean-reverting AR(1) idios (ρ=0.3) on top of a shared driver →
    // ADF rejects the unit root in the OLS residual → low p-value → no
    // decoupling alarm.
    const a: number[] = [];
    const b: number[] = [];
    let ra = 0, rb = 0;
    for (let i = 0; i < 200; i++) {
      ra = 0.3 * ra + 0.005 * Math.sin((2 * Math.PI * i) / 7);
      rb = 0.3 * rb + 0.005 * Math.cos((2 * Math.PI * i) / 9);
      const driver = 0.002 * i + 0.08 * Math.cos((2 * Math.PI * i) / 40);
      a.push(driver + ra);
      b.push(driver + rb);
    }
    const r = detectRegime(a, b);
    expect(r.pValue).not.toBeNull();
    expect(r.decoupling).toBe(false);
  });

  it('two independent random-walks flag decoupling=true', () => {
    // Two independent linear-drifts on different slopes — no cointegration.
    const a = logSeries((i) => 0.005 * i + 0.01 * Math.sin((2 * Math.PI * i) / 19), 200);
    const b = logSeries((i) => -0.003 * i + 0.01 * Math.cos((2 * Math.PI * i) / 23), 200);
    const r = detectRegime(a, b);
    expect(r.decoupling).toBe(true);
  });

  it('pValue is null when no B series passed', () => {
    const s = logSeries((i) => 0.01 * i, 200);
    const r = detectRegime(s);
    expect(r.pValue).toBeNull();
    expect(r.decoupling).toBe(false);
  });

  it('B series shorter than lookback yields pValue=null', () => {
    const a = logSeries((i) => 0.005 * i, 200);
    const b = a.slice(0, 30);
    const r = detectRegime(a, b, { lookbackBars: 60 });
    expect(r.pValue).toBeNull();
  });

  it('decouplingPValueAlarm tunes sensitivity', () => {
    const a = logSeries((i) => 0.005 * i, 200);
    const b = logSeries((i) => 0.005 * i + 0.01 * Math.sin((2 * Math.PI * i) / 20), 200);
    const strict = detectRegime(a, b, { decouplingPValueAlarm: 0.001 });
    const loose = detectRegime(a, b, { decouplingPValueAlarm: 0.99 });
    expect(strict.decoupling).toBe(true);
    expect(loose.decoupling).toBe(false);
  });
});

describe('detectRegime — input validation', () => {
  it('throws when input is shorter than lookback', () => {
    const s = logSeries((i) => 0.01 * i, 20);
    expect(() => detectRegime(s, null, { lookbackBars: 60 })).toThrow();
  });

  it('throws when lookbackBars < 10', () => {
    const s = logSeries((i) => 0.01 * i, 200);
    expect(() => detectRegime(s, null, { lookbackBars: 5 })).toThrow();
  });
});
