import { crossSectionalRankSignals } from './regime-cross-sectional';

describe('crossSectionalRankSignals (P12 headline)', () => {
  // Three symbols, lookback 1: at each bar rank by the last 1-bar return.
  const A = { symbol: 'A', prices: [100, 110, 110, 99], barTimesMs: [0, 1, 2, 3] }; // rets: NaN,+.0953,0,-.105
  const B = { symbol: 'B', prices: [100, 100, 105, 105], barTimesMs: [0, 1, 2, 3] }; // rets: NaN,0,+.0488,0
  const C = { symbol: 'C', prices: [100, 95, 100, 110], barTimesMs: [0, 1, 2, 3] }; // rets: NaN,-.0513,+.0513,+.0953

  it('ranks the universe at each bar: top → +1, bottom → −1, middle → 0', () => {
    const sig = crossSectionalRankSignals([A, B, C], 1);
    // bar 1: returns A +0.0953 (top), B 0 (mid), C −0.0513 (bottom)
    expect(sig.get('A')![1]).toBeCloseTo(1, 9);
    expect(sig.get('B')![1]).toBeCloseTo(0, 9);
    expect(sig.get('C')![1]).toBeCloseTo(-1, 9);
  });

  it('flips the ranking when the cross-section flips', () => {
    const sig = crossSectionalRankSignals([A, B, C], 1);
    // bar 3: A −0.105 (bottom), B 0 (mid), C +0.0953 (top)
    expect(sig.get('A')![3]).toBeCloseTo(-1, 9);
    expect(sig.get('B')![3]).toBeCloseTo(0, 9);
    expect(sig.get('C')![3]).toBeCloseTo(1, 9);
  });

  it('is NaN during the warmup (no trailing return yet ⇒ no view)', () => {
    const sig = crossSectionalRankSignals([A, B, C], 1);
    expect(Number.isNaN(sig.get('A')![0])).toBe(true);
    expect(Number.isNaN(sig.get('B')![0])).toBe(true);
    expect(Number.isNaN(sig.get('C')![0])).toBe(true);
  });

  it('excludes a symbol with an undefined return from that bar’s ranking', () => {
    const D = { symbol: 'D', prices: [100, 0, 105, 105], barTimesMs: [0, 1, 2, 3] }; // bar1 ret NaN (zero price)
    const sig = crossSectionalRankSignals([A, B, D], 1);
    expect(Number.isNaN(sig.get('D')![1])).toBe(true); // D has no defined return at bar 1
    // A and B still ranked among the present names (A top, B bottom of the 2 present).
    expect(sig.get('A')![1]).toBeCloseTo(1, 9);
    expect(sig.get('B')![1]).toBeCloseTo(-1, 9);
  });

  it('is demeaned across an odd cross-section (median = 0)', () => {
    const sig = crossSectionalRankSignals([A, B, C], 1);
    for (let i = 1; i < 4; i++) {
      const sum = sig.get('A')![i] + sig.get('B')![i] + sig.get('C')![i];
      if (Number.isFinite(sum)) expect(sum).toBeCloseTo(0, 9);
    }
  });
});
