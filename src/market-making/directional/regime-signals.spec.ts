import { FundingPoint } from '../../market-data/funding/funding-source.interface';
import { computeIc } from '../bias/oos/forward-return-ic';
import {
  RegimeSeries,
  trailingFundingPerHour,
  fundingPaidSideSignal,
  trailingMomentum,
  regimeSignalSeries,
  regimeSignalPairs,
  defaultRegimeSignalSpecs,
} from './regime-signals';

const H = 3_600_000; // one hour in ms
const fp = (hour: number, rate: number): FundingPoint => ({
  symbol: 'X',
  fundingTimeMs: hour * H,
  fundingRate: rate,
  markPrice: 100,
});

describe('trailingFundingPerHour', () => {
  // Bars at hours 10, 11, 12; trailing window 2h. Settlements span before/within/after.
  const barTimesMs = [10 * H, 11 * H, 12 * H];
  const funding = [fp(9, 0.001), fp(10, 0.002), fp(11.5, 0.004), fp(13, 0.008), fp(20, 100)];

  it('averages only settlements at-or-before the bar within the trailing window', () => {
    const out = trailingFundingPerHour(barTimesMs, funding, 2);
    // bar@10h window (8h,10h]: 9h + 10h ⇒ (0.001+0.002)/2
    expect(out[0]).toBeCloseTo(0.0015, 12);
    // bar@11h window (9h,11h]: only 10h (9h is excluded — strictly >)
    expect(out[1]).toBeCloseTo(0.002, 12);
    // bar@12h window (10h,12h]: only 11.5h (10h excluded; 13h/20h are the future)
    expect(out[2]).toBeCloseTo(0.004, 12);
  });

  it('never looks ahead: a far-future settlement cannot change a past bar', () => {
    const withFuture = trailingFundingPerHour(barTimesMs, funding, 2);
    const withoutFuture = trailingFundingPerHour(barTimesMs, [fp(9, 0.001), fp(10, 0.002), fp(11.5, 0.004)], 2);
    expect(withFuture).toEqual(withoutFuture);
  });

  it('is NaN when no settlement falls in the window (no funding view)', () => {
    const out = trailingFundingPerHour([5 * H], [fp(9, 0.001)], 2);
    expect(Number.isNaN(out[0])).toBe(true);
  });
});

describe('fundingPaidSideSignal', () => {
  it('is the negation of trailing funding (long the paid side), NaN-preserving', () => {
    const barTimesMs = [10 * H, 5 * H];
    const funding = [fp(9, 0.001), fp(10, 0.002)];
    expect(fundingPaidSideSignal(barTimesMs, funding, 2)).toEqual([-0.0015, NaN]);
  });
});

describe('trailingMomentum', () => {
  it('is the trailing L-bar log return; the first L bars are NaN', () => {
    const prices = [100, 110, 121];
    const out = trailingMomentum(prices, 1);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBeCloseTo(Math.log(1.1), 12);
    expect(out[2]).toBeCloseTo(Math.log(1.1), 12);
  });

  it('never looks ahead: mutating a future price leaves an earlier signal unchanged', () => {
    const a = trailingMomentum([100, 101, 102, 103, 104], 2);
    const b = trailingMomentum([100, 101, 102, 103, 999], 2);
    expect(a[2]).toBeCloseTo(b[2], 12); // depends only on prices[0..2]
    expect(a[2]).toBeCloseTo(Math.log(102 / 100), 12);
  });
});

describe('regimeSignalSeries dispatch', () => {
  const series: RegimeSeries = {
    prices: [100, 110, 121],
    barTimesMs: [10 * H, 11 * H, 12 * H],
    funding: [fp(10, 0.002)],
  };
  it('routes a funding spec to the funding-paid-side builder', () => {
    expect(regimeSignalSeries({ name: 'f', kind: 'funding-paid-side', windowHours: 2 }, series))
      .toEqual(fundingPaidSideSignal(series.barTimesMs, series.funding, 2));
  });
  it('routes a momentum spec to the trailing-momentum builder', () => {
    expect(regimeSignalSeries({ name: 'm', kind: 'momentum', lookbackBars: 1 }, series))
      .toEqual(trailingMomentum(series.prices, 1));
  });
});

describe('regimeSignalPairs — known-answer IC', () => {
  // A persistent up/down block series: within a block momentum and the forward
  // return share a sign, so leaning the trend predicts forward return (positive IC).
  function blockSeries(): RegimeSeries {
    const prices: number[] = [];
    let p = 100;
    const blockLen = 40;
    const blocks = 8;
    for (let b = 0; b < blocks; b++) {
      const up = b % 2 === 0;
      for (let k = 0; k < blockLen; k++) {
        p *= up ? 1.01 : 0.99;
        prices.push(p);
      }
    }
    const barTimesMs = prices.map((_, i) => i * H);
    return { prices, barTimesMs, funding: [] };
  }

  it('a trending series gives a positive momentum IC and edge', () => {
    const pairs = regimeSignalPairs({ name: 'm', kind: 'momentum', lookbackBars: 4 }, blockSeries(), 4);
    const ic = computeIc(pairs);
    expect(pairs.length).toBeGreaterThan(100);
    expect(ic.spearmanIc).toBeGreaterThan(0.1);
    expect(ic.meanDirectionPnl).toBeGreaterThan(0);
    expect(ic.hitRate).toBeGreaterThan(0.6);
  });

  it('a flat (no-information) market produces NO positions to score', () => {
    const flat: RegimeSeries = { prices: new Array(200).fill(100), barTimesMs: [], funding: [] };
    const pairs = regimeSignalPairs({ name: 'm', kind: 'momentum', lookbackBars: 4 }, flat, 4);
    expect(pairs.length).toBe(0); // momentum of a flat series is exactly 0 ⇒ dropped (no view)
  });
});

describe('defaultRegimeSignalSpecs', () => {
  it('emits one funding spec per window and one momentum spec per lookback (hours→bars)', () => {
    // isolate funding+momentum by disabling the P12 families (reversal / vol-scaled-momentum).
    const specs = defaultRegimeSignalSpecs({ intervalHours: 1, momentumLookbackHours: [24, 72], fundingWindowHours: [8], reversalLookbackHours: [], volScaledMomentumLookbackHours: [] });
    expect(specs.map((s) => s.name)).toEqual(['funding-paid-side(8h)', 'momentum(24h)', 'momentum(72h)']);
    expect(specs[0]).toMatchObject({ kind: 'funding-paid-side', windowHours: 8 });
    expect(specs[1]).toMatchObject({ kind: 'momentum', lookbackBars: 24 });
    expect(specs[2]).toMatchObject({ kind: 'momentum', lookbackBars: 72 });
  });

  it('converts hour-lookbacks to bars by the interval', () => {
    const specs = defaultRegimeSignalSpecs({ intervalHours: 4, momentumLookbackHours: [24], fundingWindowHours: [], reversalLookbackHours: [], volScaledMomentumLookbackHours: [] });
    expect(specs).toHaveLength(1);
    expect(specs[0].lookbackBars).toBe(6); // 24h / 4h-bars
  });

  it('includes the P12 family set by default (funding + momentum + vol-scaled-momentum + reversal)', () => {
    const kinds = new Set(defaultRegimeSignalSpecs({ intervalHours: 1 }).map((s) => s.kind));
    expect(kinds).toEqual(new Set(['funding-paid-side', 'momentum', 'vol-scaled-momentum', 'reversal']));
  });
});
