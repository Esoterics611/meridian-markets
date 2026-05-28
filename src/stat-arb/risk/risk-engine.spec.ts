import { DrawdownGate } from './drawdown-gate';
import { VenueCapGate } from './venue-cap';
import { ExposureCapsGate } from './exposure-caps';
import { CorrelationCapGate } from './correlation-cap';
import { RiskEngine, allAllow } from './risk-engine';

function engine() {
  return new RiskEngine({
    drawdown: new DrawdownGate({ maxDrawdownPct: 5 }),
    venueCap: new VenueCapGate({ maxNotionalUnitsPerVenue: 10_000_000n }),
    exposure: new ExposureCapsGate({
      maxGrossUnits: 10_000_000n,
      maxNetUnits: 3_000_000n,
      maxPairUnits: 4_000_000n,
    }),
    correlation: new CorrelationCapGate({ maxAbsCorrelation: 0.7, minOverlapBars: 5 }),
  });
}

describe('RiskEngine', () => {
  it('returns no decisions for an empty context', () => {
    const e = engine();
    const d = e.preTradeCheck({ barIndex: 0 });
    expect(d).toEqual([]);
  });

  it('skips gates whose state is not present', () => {
    const e = engine();
    const d = e.preTradeCheck({ barIndex: 0, drawdown: { navRatio: 1.0, peakNav: 1.0 } });
    expect(d.length).toBe(1);
    expect(allAllow(d)).toBe(true);
  });

  it('records DRAWDOWN event on breach', () => {
    const e = engine();
    e.preTradeCheck({ barIndex: 12, drawdown: { navRatio: 0.94, peakNav: 1.0 } });
    const evs = e.drainEvents();
    expect(evs.length).toBe(1);
    expect(evs[0].kind).toBe('DRAWDOWN');
    expect(evs[0].barIndex).toBe(12);
  });

  it('records VENUE_CAP event on breach', () => {
    const e = engine();
    e.preTradeCheck({ barIndex: 5, venueCap: { venueId: 'mock', liveNotionalUnits: 9_500_000n, addNotionalUnits: 1_000_000n } });
    expect(e.drainEvents()[0].kind).toBe('VENUE_CAP');
  });

  it('disambiguates EXPOSURE_GROSS vs NET vs PAIR via reason prefix', () => {
    const e = engine();
    e.preTradeCheck({
      barIndex: 1,
      exposure: {
        positions: [{ pairId: 'x/y', longUnits: 5_000_000n, shortUnits: 4_500_000n }],
        intent: { pairId: 'btc/eth', longUnits: 2_000_000n, shortUnits: 0n },
      },
    });
    e.preTradeCheck({
      barIndex: 2,
      exposure: {
        positions: [{ pairId: 'x/y', longUnits: 3_000_000n, shortUnits: 0n }],
        intent: { pairId: 'btc/eth', longUnits: 1_000_000n, shortUnits: 0n },
      },
    });
    e.preTradeCheck({
      barIndex: 3,
      exposure: {
        positions: [{ pairId: 'btc/eth', longUnits: 2_500_000n, shortUnits: 1_500_000n }],
        intent: { pairId: 'btc/eth', longUnits: 500_000n, shortUnits: 0n },
      },
    });
    const kinds = e.drainEvents().map((ev) => ev.kind);
    expect(kinds).toContain('EXPOSURE_GROSS');
    expect(kinds).toContain('EXPOSURE_NET');
    expect(kinds).toContain('EXPOSURE_PAIR');
  });

  it('records CORRELATION event on breach', () => {
    const e = engine();
    const c = [1, 2, 3, 4, 5, 6, 7];
    e.preTradeCheck({
      barIndex: 9,
      correlation: { candidate: c, openLegs: [{ id: 'a', returns: c.slice() }] },
    });
    expect(e.drainEvents()[0].kind).toBe('CORRELATION');
  });

  it('allAllow reports false when any decision denies', () => {
    expect(allAllow([{ allow: true }, { allow: false, reason: 'x' }])).toBe(false);
    expect(allAllow([{ allow: true }, { allow: true }])).toBe(true);
  });

  it('drainEvents returns a defensive copy', () => {
    const e = engine();
    e.preTradeCheck({ barIndex: 0, drawdown: { navRatio: 0.9, peakNav: 1.0 } });
    const a = e.drainEvents();
    const b = e.drainEvents();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
