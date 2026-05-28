import { VenueCapGate } from './venue-cap';

describe('VenueCapGate', () => {
  const gate = new VenueCapGate({ maxNotionalUnitsPerVenue: 10_000_000n });

  it('allows when projected total stays under the cap', () => {
    expect(gate.check({ venueId: 'mock', liveNotionalUnits: 5_000_000n, addNotionalUnits: 1_000_000n }).allow).toBe(true);
  });

  it('allows at exactly the cap (only strict overflow blocks)', () => {
    expect(gate.check({ venueId: 'mock', liveNotionalUnits: 9_000_000n, addNotionalUnits: 1_000_000n }).allow).toBe(true);
  });

  it('blocks when projected total exceeds the cap', () => {
    const d = gate.check({ venueId: 'mock', liveNotionalUnits: 9_500_000n, addNotionalUnits: 1_000_000n });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/cap/);
  });

  it('blocks when already over the cap and we try to add more', () => {
    const d = gate.check({ venueId: 'mock', liveNotionalUnits: 11_000_000n, addNotionalUnits: 1n });
    expect(d.allow).toBe(false);
  });

  it('surfaces venueId + projected + cap in detail payload', () => {
    const d = gate.check({ venueId: 'binance', liveNotionalUnits: 9_500_000n, addNotionalUnits: 1_000_000n });
    expect(d.detail?.venueId).toBe('binance');
    expect(d.detail?.cap).toBe('10000000');
  });
});
