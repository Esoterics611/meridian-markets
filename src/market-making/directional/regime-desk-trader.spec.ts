import { RegimeDeskTrader, SeatedRegimeBook, RegimeSymbolTick, RegimeMarketTick } from './regime-desk-trader';
import { RegimeDirectionalBook } from './regime-directional-book';
import { RegimeMonitor } from './regime-monitor';
import { BiasReading } from '../bias/bias-source.interface';

const toMicros = (x: number) => BigInt(Math.round(x * 1_000_000));

function seatBook(symbol: string, ic = 0.3): SeatedRegimeBook {
  return {
    symbol,
    ic,
    signalName: 'momentum(24h)',
    allocNotionalUsd: 25_000,
    book: new RegimeDirectionalBook({ baseNotionalUsd: 50_000, maxNotionalUsd: 25_000, book: symbol }),
    monitor: new RegimeMonitor(symbol),
  };
}

function trader() {
  return new RegimeDeskTrader({
    deskRisk: { maxGrossUsd: 300_000, maxNetUsd: 200_000, dailyLossLimitUsd: 6_000, capitalUsd: 150_000, maxDrawdownFrac: 0.02 },
    marketSymbol: 'BTC',
  });
}

const reading = (bias: number): BiasReading => ({ bias, validated: true, reason: 'test' });

function tick(symbol: string, midUsd: number, bias: number, ret = 0.001): [string, RegimeSymbolTick] {
  return [symbol, { nowMs: Date.now(), midMicros: toMicros(midUsd), fundingRatePerHour: 1e-5, basisBps: 1, ret, reading: reading(bias), recentReturns: [0.001, -0.001, 0.002, ret] }];
}

describe('RegimeDeskTrader (P13)', () => {
  it('seats books and reports them not-running until started', () => {
    const t = trader();
    t.seat([seatBook('ETH'), seatBook('SOL')]);
    expect(t.bookCount()).toBe(2);
    expect(t.isRunning()).toBe(false);
    const snap = t.snapshot();
    expect(snap.positions).toHaveLength(2);
    expect(snap.positions.every((p) => p.side === 'FLAT')).toBe(true);
  });

  it('opens a position on a strong validated view and surfaces it in the snapshot', () => {
    const t = trader();
    t.seat([seatBook('ETH', 0.4)]);
    t.start();
    const market: RegimeMarketTick = { symbol: 'BTC', midUsd: 60_000, returns: [0.01, -0.01, 0.02, -0.02] };
    t.tick(new Map([tick('ETH', 1_800, 0.5)]), market);
    const snap = t.snapshot();
    expect(snap.running).toBe(true);
    const eth = snap.positions.find((p) => p.symbol === 'ETH')!;
    expect(eth.side).toBe('LONG'); // bias +0.5, validated ⇒ long
    expect(eth.notionalUsd).toBeGreaterThan(0);
    expect(snap.desk.live).toBe(1);
  });

  it('accrues beta P&L and the TCA reconciles to the desk total to the cent', () => {
    const t = trader();
    t.seat([seatBook('ETH', 0.4)]);
    t.start();
    // tick 1: open long. tick 2: market moves, so beta P&L accrues on the held position.
    t.tick(new Map([tick('ETH', 1_800, 0.5)]), { symbol: 'BTC', midUsd: 60_000, returns: [0.01, -0.01, 0.02] });
    t.tick(new Map([tick('ETH', 1_840, 0.5)]), { symbol: 'BTC', midUsd: 61_200, returns: [0.02, -0.01, 0.03] });
    const snap = t.snapshot();
    const a = snap.attribution;
    // idio + beta + funding − fees − slip == total (to the cent; floats here ⇒ tolerance).
    expect(a.idiosyncraticUsd + a.betaUsd + a.fundingUsd - a.feesUsd - a.slippageUsd).toBeCloseTo(a.totalUsd, 6);
    expect(snap.risk).not.toBeNull();
  });

  it('halt() flattens every book and latches', () => {
    const t = trader();
    t.seat([seatBook('ETH', 0.4), seatBook('SOL', 0.4)]);
    t.start();
    const market: RegimeMarketTick = { symbol: 'BTC', midUsd: 60_000, returns: [0.01, -0.01, 0.02] };
    t.tick(new Map([tick('ETH', 1_800, 0.5), tick('SOL', 70, 0.5)]), market);
    expect(t.snapshot().desk.live).toBe(2);
    t.halt();
    t.tick(new Map([tick('ETH', 1_800, 0.5), tick('SOL', 70, 0.5)]), market);
    const snap = t.snapshot();
    expect(snap.halted).toBe(true);
    expect(snap.desk.live).toBe(0); // every book flattened on the halt
  });

  it('flatten(symbol) queues a one-book flatten', () => {
    const t = trader();
    t.seat([seatBook('ETH', 0.4), seatBook('SOL', 0.4)]);
    t.start();
    const market: RegimeMarketTick = { symbol: 'BTC', midUsd: 60_000, returns: [0.01, -0.01, 0.02] };
    t.tick(new Map([tick('ETH', 1_800, 0.5), tick('SOL', 70, 0.5)]), market);
    expect(t.flatten('ETH')).toBe(true);
    expect(t.flatten('NOPE')).toBe(false);
    t.tick(new Map([tick('ETH', 1_800, 0.5), tick('SOL', 70, 0.5)]), market);
    const snap = t.snapshot();
    expect(snap.positions.find((p) => p.symbol === 'ETH')!.side).toBe('FLAT');
    expect(snap.positions.find((p) => p.symbol === 'SOL')!.side).toBe('LONG'); // SOL untouched
  });
});
