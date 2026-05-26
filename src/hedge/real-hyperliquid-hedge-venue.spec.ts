import { RealHyperliquidHedgeVenue } from './real-hyperliquid-hedge-venue';
import { HedgeVenueNotConfiguredError } from './hedge-venue.interface';

describe('RealHyperliquidHedgeVenue (dormant in Phase 1 scaffold)', () => {
  const venue = new RealHyperliquidHedgeVenue();

  it('exposes a stable venueId', () => {
    expect(venue.venueId).toBe('hyperliquid');
  });

  it('throws HedgeVenueNotConfiguredError on openShort', async () => {
    await expect(
      venue.openShort({ notionalUnits: 1n, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(HedgeVenueNotConfiguredError);
  });

  it('throws HedgeVenueNotConfiguredError on closeShort', async () => {
    await expect(
      venue.closeShort({ positionRef: 'p', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(HedgeVenueNotConfiguredError);
  });

  it('throws HedgeVenueNotConfiguredError on fetchPosition', async () => {
    await expect(venue.fetchPosition('p')).rejects.toBeInstanceOf(HedgeVenueNotConfiguredError);
  });

  it('throws HedgeVenueNotConfiguredError on fetchHealth', async () => {
    await expect(venue.fetchHealth()).rejects.toBeInstanceOf(HedgeVenueNotConfiguredError);
  });
});
