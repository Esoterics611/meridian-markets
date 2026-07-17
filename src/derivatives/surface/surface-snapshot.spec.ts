import { DeribitOption } from '../deribit/deribit-client';
import { pickExpiryForTenor, selectTenorPicks } from './surface-snapshot';

// O-E1 selection spec — the honesty rules under test: (1) no expiry near the target
// tenor ⇒ no row (never a mislabeled tenor); (2) a wing outside ±0.10 of its target
// delta is omitted (never a 30Δ wearing a 10Δ label); (3) ATM/wing picks land where
// BS says they should on a synthetic chain with a known skew.

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const SPOT = 60_000;

/** Synthetic BTC chain at one expiry: dense strike grid, put-skewed smile. */
function chainAt(expiryDays: number, strikeStepFrac = 0.025): DeribitOption[] {
  const expiryMs = NOW + expiryDays * DAY_MS;
  const out: DeribitOption[] = [];
  for (let m = 0.6; m <= 1.4; m += strikeStepFrac) {
    const strike = Math.round(SPOT * m);
    // skew: higher IV below spot (puts rich), mild call wing — a crypto-fear smile
    const k = Math.log(SPOT / strike);
    const iv = 0.37 + 0.35 * Math.max(k, 0) + 0.1 * Math.max(-k, 0);
    for (const type of ['CALL', 'PUT'] as const) {
      out.push({
        instrumentName: `BTC-${expiryDays}D-${strike}-${type[0]}`,
        currency: 'BTC',
        type,
        strike,
        expiryMs,
        markIv: iv,
        underlyingPrice: SPOT,
        markPriceCoin: 0.01,
        openInterest: 100,
        volume: 10,
      });
    }
  }
  return out;
}

describe('pickExpiryForTenor', () => {
  it('picks the nearest expiry within tolerance', () => {
    const es = [7, 14, 28, 91].map((d) => NOW + d * DAY_MS);
    expect(pickExpiryForTenor(es, 30, NOW)).toBe(NOW + 28 * DAY_MS);
    expect(pickExpiryForTenor(es, 7, NOW)).toBe(NOW + 7 * DAY_MS);
    expect(pickExpiryForTenor(es, 90, NOW)).toBe(NOW + 91 * DAY_MS);
  });

  it('returns undefined when nothing is near the tenor — a mislabeled row is worse than no row', () => {
    const es = [1, 2, 180].map((d) => NOW + d * DAY_MS);
    expect(pickExpiryForTenor(es, 30, NOW)).toBeUndefined(); // tol = max(2, 10.5) = 10.5d
    expect(pickExpiryForTenor(es, 14, NOW)).toBeUndefined();
  });

  it('ignores expired timestamps', () => {
    const es = [NOW - DAY_MS, NOW + 7 * DAY_MS];
    expect(pickExpiryForTenor(es, 7, NOW)).toBe(NOW + 7 * DAY_MS);
  });
});

describe('selectTenorPicks', () => {
  it('picks ATM at the nearest strike and all three wings at their deltas on a dense chain', () => {
    const picks = selectTenorPicks(chainAt(30), 30, NOW)!;
    expect(picks).toBeDefined();
    expect(picks.underlying).toBe('BTC');
    expect(Math.abs(picks.atmStrike - SPOT)).toBeLessThanOrEqual(SPOT * 0.0125); // half a strike step
    expect(picks.atmIv).toBeGreaterThan(0.3);

    expect(picks.put25).toBeDefined();
    expect(picks.put10).toBeDefined();
    expect(picks.call25).toBeDefined();
    expect(picks.put25!.delta).toBeCloseTo(-0.25, 1);
    expect(picks.put10!.delta).toBeCloseTo(-0.1, 1);
    expect(picks.call25!.delta).toBeCloseTo(0.25, 1);
    // geometry: 10Δ put strikes below 25Δ put, both below spot; 25Δ call above
    expect(picks.put10!.strike).toBeLessThan(picks.put25!.strike);
    expect(picks.put25!.strike).toBeLessThan(SPOT);
    expect(picks.call25!.strike).toBeGreaterThan(SPOT);
    // the synthetic smile is put-skewed ⇒ rr25 positive
    expect(picks.rr25!).toBeGreaterThan(0);
  });

  it('omits a wing when the strike grid cannot reach its delta (sparse chain)', () => {
    // strikes only within ±10% of spot: at 30d/37 vol the 10Δ put (~25% below) has no candidate
    const sparse = chainAt(30, 0.05).filter((o) => Math.abs(o.strike - SPOT) <= SPOT * 0.1);
    const picks = selectTenorPicks(sparse, 30, NOW)!;
    expect(picks).toBeDefined();
    expect(picks.put10).toBeUndefined();
    expect(picks.rr25).toBeDefined(); // 25Δ wings still reachable
  });

  it('returns undefined when the chain has no expiry near the tenor', () => {
    expect(selectTenorPicks(chainAt(3), 30, NOW)).toBeUndefined();
  });

  it('filters dead quotes (markIv 0) before selecting', () => {
    const chain = chainAt(30).map((o) => ({ ...o, markIv: 0 }));
    expect(selectTenorPicks(chain, 30, NOW)).toBeUndefined();
  });
});
