import { statArbBlockedEvent, statArbEntryEvent, statArbExitEvent, statArbLifecycleEvent } from './live-desk-events';

const M = 1_000_000n;

describe('stat-arb desk-event builders', () => {
  it('builds an OPEN event tagged to the stat-arb desk with the leg phrasing', () => {
    const e = statArbEntryEvent({
      ts: 1000,
      pair: 'ETH/BTC',
      source: 'binance.spot',
      side: 'LONG',
      notionalUnits: 50n * M,
      entryZ: -2.1,
      feeUnits: 50_000n, // $0.05 cost
      symbolA: 'ETH',
      symbolB: 'BTC',
    });
    expect(e.desk).toBe('stat-arb');
    expect(e.kind).toBe('fill');
    expect(e.action).toBe('open');
    expect(e.book).toBe('ETH/BTC');
    expect(e.sizeUnits).toBe((50n * M).toString());
    expect(e.realisedDeltaUnits).toBe('0');
    // long A / short B, fee rendered as a P&L drag (−)
    expect(e.message).toContain('OPEN LONG $50/leg @ z=-2.10');
    expect(e.message).toContain('long ETH / short BTC');
    expect(e.message).toContain('fee −$0.05');
  });

  it('builds a CLOSE event carrying the realised round-trip P&L', () => {
    const e = statArbExitEvent({
      ts: 2000,
      pair: 'ETH/BTC',
      source: 'binance.spot',
      side: 'LONG',
      notionalUnits: 50n * M,
      exitZ: -0.1,
      realisedDeltaUnits: 1_200_000n, // +$1.20 net
      feeUnits: 100_000n,
    });
    expect(e.action).toBe('close');
    expect(e.realisedDeltaUnits).toBe('1200000');
    expect(e.message).toContain('CLOSE LONG $50/leg @ z=-0.10');
    expect(e.message).toContain('realised +$1.20');
  });

  it('builds a risk-block event as a (louder) verdict kind', () => {
    const e = statArbBlockedEvent({ ts: 3000, pair: 'ETH/BTC', source: 'binance.spot', side: 'SHORT', barIndex: 142 });
    expect(e.kind).toBe('verdict');
    expect(e.verdict).toBe('Deny');
    expect(e.message).toContain('blocked by risk gate (drawdown) @ bar 142');
  });

  it('builds lifecycle events on the stat-arb desk', () => {
    const e = statArbLifecycleEvent({ ts: 4000, kind: 'start', book: 'ETH/BTC', source: 'binance.spot', message: 'started' });
    expect(e.desk).toBe('stat-arb');
    expect(e.kind).toBe('start');
    expect(e.book).toBe('ETH/BTC');
  });
});
