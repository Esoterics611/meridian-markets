import { splitAcrossVenues } from './multi-venue-split';

describe('splitAcrossVenues', () => {
  it('routes everything to one venue when only one is provided', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [{ venueId: 'mock', advUnits: 1_000_000_000n }],
    });
    expect(r.allocations.length).toBe(1);
    expect(r.allocations[0].notionalUnits).toBe(1_000_000n);
    expect(r.underfilled).toBe(false);
  });

  it('allocates approximately proportional to ADV under equal lambda', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [
        { venueId: 'a', advUnits: 100_000_000n },
        { venueId: 'b', advUnits: 300_000_000n },
      ],
    });
    const byId = new Map(r.allocations.map((a) => [a.venueId, a.notionalUnits]));
    const aShare = Number(byId.get('a')!) / 1_000_000;
    const bShare = Number(byId.get('b')!) / 1_000_000;
    // a:b ADV is 1:3 → expect b to get ~3x what a gets, within a few %.
    expect(bShare / aShare).toBeGreaterThan(2.5);
    expect(bShare / aShare).toBeLessThan(3.5);
  });

  it('total allocated equals parent notional when no caps bind', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [
        { venueId: 'a', advUnits: 100_000_000n },
        { venueId: 'b', advUnits: 100_000_000n },
        { venueId: 'c', advUnits: 100_000_000n },
      ],
    });
    expect(r.totalAllocatedUnits).toBe(1_000_000n);
  });

  it('honors per-venue maxNotionalUnits caps', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [
        { venueId: 'a', advUnits: 100_000_000n, maxNotionalUnits: 200_000n },
        { venueId: 'b', advUnits: 100_000_000n },
      ],
    });
    const a = r.allocations.find((x) => x.venueId === 'a')!;
    expect(a.notionalUnits).toBeLessThanOrEqual(200_000n);
    // Cap shifts the remainder to b.
    const b = r.allocations.find((x) => x.venueId === 'b')!;
    expect(b.notionalUnits).toBeGreaterThan(500_000n);
  });

  it('reports underfilled when all venues hit their caps', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [
        { venueId: 'a', advUnits: 100_000_000n, maxNotionalUnits: 100_000n },
        { venueId: 'b', advUnits: 100_000_000n, maxNotionalUnits: 100_000n },
      ],
    });
    expect(r.underfilled).toBe(true);
    expect(r.totalAllocatedUnits).toBeLessThanOrEqual(200_000n);
  });

  it('returns no allocations for zero parent notional', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 0n,
      side: 'BUY',
      venues: [{ venueId: 'a', advUnits: 100_000_000n }],
    });
    expect(r.allocations).toEqual([]);
    expect(r.underfilled).toBe(false);
  });

  it('throws on empty venue list', () => {
    expect(() => splitAcrossVenues({ parentNotionalUnits: 1n, side: 'BUY', venues: [] })).toThrow();
  });

  it('total estCostUnits equals the sum of per-venue estCostUnits', () => {
    const r = splitAcrossVenues({
      parentNotionalUnits: 1_000_000n,
      side: 'BUY',
      venues: [
        { venueId: 'a', advUnits: 100_000_000n },
        { venueId: 'b', advUnits: 300_000_000n },
      ],
    });
    const sum = r.allocations.reduce((s, a) => s + a.estCostUnits, 0n);
    expect(sum).toBe(r.totalEstCostUnits);
  });
});
