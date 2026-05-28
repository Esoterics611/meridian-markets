import { ALLOW, deny, GateDecision } from './gate';

// VenueCapGate — caps gross notional per venue. Trips when adding the new
// order would push the venue's running notional over the cap.

export interface VenueCapConfig {
  /** Max notional (USDC units) any one venue may hold concurrently. */
  maxNotionalUnitsPerVenue: bigint;
}

export interface VenueCapState {
  venueId: string;
  /** Already-deployed notional on this venue (USDC units, absolute). */
  liveNotionalUnits: bigint;
  /** The order we want to add. */
  addNotionalUnits: bigint;
}

export class VenueCapGate {
  constructor(private readonly cfg: VenueCapConfig) {}

  check(s: VenueCapState): GateDecision {
    const projected = s.liveNotionalUnits + s.addNotionalUnits;
    if (projected > this.cfg.maxNotionalUnitsPerVenue) {
      return deny(
        `venue ${s.venueId} notional ${projected.toString()} > cap ${this.cfg.maxNotionalUnitsPerVenue.toString()}`,
        {
          venueId: s.venueId,
          projected: projected.toString(),
          cap: this.cfg.maxNotionalUnitsPerVenue.toString(),
        },
      );
    }
    return ALLOW;
  }
}
