import { BasisSnapshot } from './cross-venue-fair-value.interface';
import { CrossVenueBasisArbDetector, computeThreshold, CrossVenueBasisArbConfig } from './cross-venue-basis-arb';
import { ICrossVenueBasisArb, MockCrossVenueBasisArb } from './cross-venue-basis-arb.interface';

// Pure unit tests — no network, no DB.

function makeSnap(symbol: string, basisBps: number): BasisSnapshot {
  const mid = 50_000;
  const basis = (basisBps / 10_000) * mid;
  return {
    symbol,
    capturedAtMs: Date.now(),
    binanceMid: mid,
    binanceFetchMs: Date.now(),
    hlMid: mid + basis,
    hlServerTsMs: Date.now() - 100,
    hlFetchMs: Date.now(),
    basis,
    basisBps,
    hlDataAgeMs: 100,
    hlBook: { symbol, ts: new Date(), bids: [], asks: [] },
  };
}

describe('computeThreshold', () => {
  it('sums cost and margin', () => {
    expect(computeThreshold(14, 5)).toBe(19);
    expect(computeThreshold(10, 3)).toBe(13);
  });
});

describe('CrossVenueBasisArbDetector', () => {
  const det = new CrossVenueBasisArbDetector({ roundTripCostBps: 14, marginBps: 5 }); // threshold 19bps

  it('returns null below threshold', () => {
    expect(det.check(makeSnap('BTC', -5))).toBeNull();
    expect(det.check(makeSnap('BTC', -18.9))).toBeNull();
    expect(det.check(makeSnap('BTC', 0))).toBeNull();
  });

  it('returns null exactly at threshold', () => {
    expect(det.check(makeSnap('BTC', -19))).toBeNull();
    expect(det.check(makeSnap('BTC', 19))).toBeNull();
  });

  it('fires LONG_HL_SHORT_BINANCE when basis < -threshold (HL is cheap)', () => {
    const sig = det.check(makeSnap('BTC', -25));
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe('LONG_HL_SHORT_BINANCE');
    expect(sig!.entryBasisBps).toBeCloseTo(-25, 3);
    expect(sig!.netEdgeBps).toBeCloseTo(25 - 14, 3); // |basis| − roundTripCost
  });

  it('fires LONG_BINANCE_SHORT_HL when basis > +threshold (Binance is cheap)', () => {
    const sig = det.check(makeSnap('ETH', 30));
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe('LONG_BINANCE_SHORT_HL');
    expect(sig!.entryBasisBps).toBeCloseTo(30, 3);
    expect(sig!.netEdgeBps).toBeCloseTo(30 - 14, 3);
  });

  it('sets roundTripCostBps and thresholdBps correctly', () => {
    expect(det.thresholdBps).toBe(19);
    const sig = det.check(makeSnap('BTC', -25));
    expect(sig!.roundTripCostBps).toBe(14);
    expect(sig!.thresholdBps).toBe(19);
  });

  it('carries the full snapshot in the signal', () => {
    const snap = makeSnap('XRP', -22);
    const sig = det.check(snap);
    expect(sig!.snapshot).toBe(snap);
    expect(sig!.symbol).toBe('XRP');
  });

  it('uses default config (14bps cost + 5bps margin = 19bps threshold)', () => {
    const d = new CrossVenueBasisArbDetector();
    expect(d.thresholdBps).toBe(19);
  });

  it('custom config: lower threshold detects smaller dislocations', () => {
    const d = new CrossVenueBasisArbDetector({ roundTripCostBps: 10, marginBps: 2 }); // threshold 12bps
    expect(d.check(makeSnap('SOL', -13))).not.toBeNull();
    expect(d.check(makeSnap('SOL', -11.9))).toBeNull();
  });

  it('satisfies the ICrossVenueBasisArb interface', () => {
    const arb: ICrossVenueBasisArb = new CrossVenueBasisArbDetector();
    expect(typeof arb.check).toBe('function');
    expect(typeof arb.thresholdBps).toBe('number');
  });
});

describe('MockCrossVenueBasisArb', () => {
  it('always returns null regardless of basis', () => {
    const mock = new MockCrossVenueBasisArb();
    expect(mock.check(makeSnap('BTC', -100))).toBeNull();
    expect(mock.check(makeSnap('BTC', 100))).toBeNull();
    expect(mock.check(makeSnap('BTC', 0))).toBeNull();
  });

  it('has configurable threshold (for docs)', () => {
    const mock = new MockCrossVenueBasisArb(25);
    expect(mock.thresholdBps).toBe(25);
  });
});
