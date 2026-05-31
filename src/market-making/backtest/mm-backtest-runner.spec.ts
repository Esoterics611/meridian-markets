import { MmBacktestRunner, MmBacktestConfig } from './mm-backtest-runner';
import { Bar } from '../../stat-arb/backtest/bar';
import { SymmetricQuoter } from '../quote/symmetric-quoter';

function bar(i: number, close: number, high: number, low: number): Bar {
  return { symbol: 'USDC', timestamp: new Date(2026, 0, 1, 0, i), open: close, high, low, close, volume: 1000 };
}

function baseCfg(bars: Bar[]): MmBacktestConfig {
  return {
    bars,
    quoter: new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }),
    quoteSizeUnits: 1_000_000n,
    gamma: 0.0025,
    kappa: 2,
    horizonBars: 1,
    volWindowBars: 3,
    volFloor: 0.0001,
    makerFeeBps: 0,
    capitalUnits: 1_000_000_000n,
  };
}

describe('MmBacktestRunner', () => {
  it('captures the spread on a tape that straddles the quotes every bar', () => {
    // close 1.0, range ±10 bps straddles the 5 bps symmetric quote both sides.
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1.0, 1.001, 0.999));
    const m = new MmBacktestRunner().run(baseCfg(bars));
    expect(m.quotingBars).toBeGreaterThan(0);
    expect(m.fills).toBe(2 * m.quotingBars); // both sides fill every quoting bar
    expect(m.bidFills).toBe(m.askFills);
    expect(m.finalInventoryUnits).toBe(0n); // balanced buys and sells
    expect(m.netPnlUnits).toBeGreaterThan(0n);
    expect(m.attribution.spreadCapturedUnits).toBeGreaterThan(0n);
    expect(m.fillRate).toBeCloseTo(1, 6);
  });

  it('places no fills when the range never reaches the quotes', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1.0, 1.0001, 0.9999));
    const m = new MmBacktestRunner().run(baseCfg(bars));
    expect(m.fills).toBe(0);
    expect(m.finalInventoryUnits).toBe(0n);
  });
});
